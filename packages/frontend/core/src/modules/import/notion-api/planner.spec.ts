import { describe, expect, test, vi } from 'vitest';

import { NotionImportWarningCode } from './constants';
import { planHierarchy, planNotionApiImport } from './planner';
import type {
  NotionBlock,
  NotionDatabase,
  NotionPage,
  NotionSource,
} from './types';

const rt = (text: string) => [{ type: 'text', plain_text: text }];
const titleProp = (text: string) => ({ type: 'title', title: rt(text) });

function page(
  id: string,
  title: string,
  parent: NotionPage['parent'],
  extra: Partial<NotionPage> = {}
): NotionPage {
  return {
    object: 'page',
    id,
    parent,
    properties: { Name: titleProp(title) },
    created_time: '2024-01-01T00:00:00.000Z',
    ...extra,
  };
}

const database: NotionDatabase = {
  object: 'database',
  id: 'db1',
  parent: { type: 'page_id', page_id: 'root' },
  title: rt('Tasks'),
  properties: {
    Name: { id: 't', name: 'Name', type: 'title' },
    Count: { id: 'c', name: 'Count', type: 'number' },
    Owner: { id: 'o', name: 'Owner', type: 'people' },
  },
};

const pages: NotionPage[] = [
  page(
    'root',
    'Root',
    { type: 'workspace' },
    {
      icon: { type: 'emoji', emoji: '📘' },
    }
  ),
  page('child', 'Child', { type: 'page_id', page_id: 'root' }),
  page('orphan', 'Orphan', { type: 'page_id', page_id: 'unshared' }),
  page('row1', 'Row 1', { type: 'database_id', database_id: 'db1' }),
  page('row2', 'Row 2', { type: 'database_id', database_id: 'db1' }),
  page('nested', 'Nested', { type: 'block_id', block_id: 'toggle1' }),
];
pages[3].properties.Count = { type: 'number', number: 3 };
pages[3].properties.Owner = {
  type: 'people',
  people: [{ id: 'u', name: 'Ann' }],
};

const bodies: Record<string, NotionBlock[]> = {
  root: [
    {
      id: 'toggle1',
      type: 'toggle',
      toggle: { rich_text: rt('T') },
      has_children: true,
      children: [
        { id: 'c1', type: 'child_page', child_page: { title: 'Nested' } },
      ],
    },
    { id: 'h', type: 'heading_1', heading_1: { rich_text: rt('Title') } },
    { id: 'todo', type: 'to_do', to_do: { rich_text: rt('x'), checked: true } },
    { id: 'weird', type: 'ai_block', ai_block: {} },
    {
      id: 'img',
      type: 'image',
      image: {
        type: 'file',
        file: { url: 'https://s3.example/a/pic.png?sig=1' },
      },
    },
    { id: 'cdb', type: 'child_database', child_database: { title: 'Tasks' } },
  ],
  child: [
    { id: 'p', type: 'paragraph', paragraph: { rich_text: rt('hello') } },
  ],
  row1: [{ id: 'rp', type: 'paragraph', paragraph: { rich_text: rt('body') } }],
};

function source(overrides: Partial<NotionSource> = {}): NotionSource {
  return {
    listAccessibleContent: async () => ({ pages, databases: [database] }),
    getBlocks: async id => bodies[id] ?? [],
    ...overrides,
  };
}

const download = vi.fn(async () => ({
  bytes: new Uint8Array([1, 2, 3]),
  mime: 'image/png',
}));

describe('planHierarchy', () => {
  test('resolves page, database, block parents and warns for inaccessible ones', () => {
    const warnings: any[] = [];
    const nodes = planHierarchy(
      {
        pages,
        databases: [database],
        blockOwners: new Map([['toggle1', 'root']]),
      },
      warnings
    );
    expect(nodes.get('root')?.parentId).toBeUndefined();
    expect(nodes.get('child')?.parentId).toBe('root');
    expect(nodes.get('db1')?.parentId).toBe('root');
    expect(nodes.get('row1')).toMatchObject({ kind: 'row', parentId: 'db1' });
    expect(nodes.get('nested')?.parentId).toBe('root');
    expect(nodes.get('orphan')?.parentId).toBeUndefined();
    expect(warnings.map(w => [w.code, w.sourcePath])).toEqual([
      [NotionImportWarningCode.InaccessibleParent, 'orphan'],
    ]);
  });
});

describe('planNotionApiImport', () => {
  test('plans mixed pages and databases into an ImportBatch', async () => {
    const progress = vi.fn();
    const { batch } = await planNotionApiImport({
      source: source(),
      downloadAsset: download,
      onProgress: progress,
    });

    const docIdByNotion = new Map(batch.docs.map(d => [d.sourcePath, d.id]));
    // root, child, orphan, nested, db1, plus row1 (has a body). row2 is an entry only.
    expect(
      [...docIdByNotion.keys()].sort((a, b) => `${a}`.localeCompare(`${b}`))
    ).toEqual(['child', 'db1', 'nested', 'orphan', 'root', 'row1']);

    const folder = (notionId: string) =>
      batch.folders!.find(f => f.path === `notion/${notionId}`)!;
    expect(folder('root')).toMatchObject({
      parentPath: undefined,
      icon: { type: 'emoji', unicode: '📘' },
      pageId: docIdByNotion.get('root'),
    });
    expect(folder('child').parentPath).toBe('notion/root');
    expect(folder('db1').parentPath).toBe('notion/root');
    expect(folder('row1').parentPath).toBe('notion/db1');
    expect(folder('nested').parentPath).toBe('notion/root');
    expect(folder('orphan').parentPath).toBeUndefined();

    const dbDoc = batch.docs.find(d => d.sourcePath === 'db1')!;
    const note = dbDoc.snapshot.blocks.children[0];
    const dbBlock = note.children[0];
    expect(dbBlock.flavour).toBe('affine:database');
    expect(dbBlock.children).toHaveLength(2);
    const columns = dbBlock.props.columns as any[];
    expect(columns.map(c => c.type)).toEqual(['title', 'number', 'rich-text']);
    const cells = dbBlock.props.cells as Record<string, Record<string, any>>;
    const row1Cells = cells[dbBlock.children[0].id];
    expect(row1Cells[columns[1].id].value).toBe(3);
    expect(row1Cells[columns[2].id].value.delta).toEqual([{ insert: 'Ann' }]);
    // row title links to the row's own doc
    expect(
      (dbBlock.children[0].props.text as any).delta[0].attributes.reference
        .pageId
    ).toBe(docIdByNotion.get('row1'));

    const codes = batch.warnings!.map(w => w.code);
    expect(codes).toContain(NotionImportWarningCode.UnsupportedProperty);
    expect(codes).toContain(NotionImportWarningCode.UnsupportedBlock);
    expect(codes).toContain(NotionImportWarningCode.InaccessibleParent);

    // asset stored as blob, transient URL not kept
    expect(batch.blobs).toHaveLength(1);
    const rootDoc = batch.docs.find(d => d.sourcePath === 'root')!;
    const json = JSON.stringify(rootDoc.snapshot);
    expect(json).toContain(batch.blobs[0].blobId);
    expect(json).not.toContain('s3.example');
    expect(progress).toHaveBeenLastCalledWith({
      completed: pages.length * 2 + 1,
      total: pages.length * 2 + 1,
    });
  });

  test('continues with a warning when an asset cannot be downloaded', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const failing = vi.fn().mockRejectedValue(new Error('HTTP 403'));
    const { batch } = await planNotionApiImport({
      source: source(),
      downloadAsset: failing,
      sleep,
      assetRetries: 2,
    });
    expect(failing).toHaveBeenCalledTimes(2);
    expect(batch.blobs).toHaveLength(0);
    expect(
      batch.warnings!.filter(
        w => w.code === NotionImportWarningCode.AssetDownloadFailed
      )
    ).toHaveLength(1);
    expect(batch.docs.some(d => d.sourcePath === 'root')).toBe(true);
  });

  test('a page whose content cannot be read yields a warning, not a failure', async () => {
    const { batch } = await planNotionApiImport({
      source: source({
        getBlocks: async id => {
          if (id === 'child') throw new Error('not shared');
          return bodies[id] ?? [];
        },
      }),
      downloadAsset: download,
    });
    expect(batch.docs.some(d => d.sourcePath === 'child')).toBe(false);
    expect(
      batch.warnings!.some(w => w.code === NotionImportWarningCode.ItemFailed)
    ).toBe(true);
  });

  test('aborts when the signal is cancelled', async () => {
    const controller = new AbortController();
    const getBlocks = vi.fn(async () => {
      controller.abort();
      return [] as NotionBlock[];
    });
    await expect(
      planNotionApiImport({
        source: source({ getBlocks }),
        downloadAsset: download,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getBlocks).toHaveBeenCalledTimes(1);
  });
});
