import 'fake-indexeddb/auto';

import { getStoreManager } from '@affine/core/blocksuite/manager/store';
import { ImportCommitService } from '@affine/core/desktop/dialogs/import/commit-service';
import { getAFFiNEWorkspaceSchema } from '@affine/core/modules/workspace';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { describe, expect, test, vi } from 'vitest';

import { planNotionApiImport } from './planner';
import type { NotionDatabase, NotionPage } from './types';

const rt = (text: string) => [{ type: 'text', plain_text: text }];

function createFolderTree() {
  const nodes = new Map<string, any>();
  const links: { parentId: string; docId: string }[] = [];
  let next = 0;
  const make = (id: string, type: string, data: string) => {
    const node = {
      id,
      type,
      data,
      children: [] as string[],
      type$: { value: type },
      data$: { value: data },
      name$: { value: type === 'folder' ? data : '' },
      get children$() {
        return { value: node.children.map(c => nodes.get(c)) };
      },
      createFolder(name: string) {
        const childId = `folder-${++next}`;
        node.children.push(childId);
        make(childId, 'folder', name);
        return childId;
      },
      createLink(_type: string, docId: string) {
        links.push({ parentId: id, docId });
        const childId = `link-${links.length}`;
        node.children.push(childId);
        make(childId, 'doc', docId);
      },
      indexAt: () => 'after',
    };
    nodes.set(id, node);
    return node;
  };
  const rootFolder = make('root', 'folder', '');
  return {
    links,
    nodes,
    service: {
      folderTree: {
        rootFolder,
        folderNode$: (id: string) => ({ value: nodes.get(id) }),
      },
    },
  };
}

describe('Notion API import commit integration', () => {
  test('commits database container docs, rows and folder placement', async () => {
    const pages: NotionPage[] = [
      {
        object: 'page',
        id: 'root',
        parent: { type: 'workspace' },
        properties: { Name: { type: 'title', title: rt('Root') } },
      },
      {
        object: 'page',
        id: 'row',
        parent: { type: 'database_id', database_id: 'db' },
        properties: {
          Name: { type: 'title', title: rt('Row') },
          Done: { type: 'checkbox', checkbox: true },
        },
      },
    ];
    const database: NotionDatabase = {
      object: 'database',
      id: 'db',
      parent: { type: 'page_id', page_id: 'root' },
      title: rt('DB'),
      properties: {
        Name: { id: 't', name: 'Name', type: 'title' },
        Done: { id: 'd', name: 'Done', type: 'checkbox' },
      },
    };
    const { batch } = await planNotionApiImport({
      source: {
        listAccessibleContent: async () => ({ pages, databases: [database] }),
        getBlocks: async () => [],
      },
      downloadAsset: vi.fn(),
    });

    const collection = new TestWorkspace({ id: 'test' });
    collection.meta.initialize();
    const tree = createFolderTree();
    const service = new ImportCommitService({
      collection,
      schema: getAFFiNEWorkspaceSchema(),
      extensions: getStoreManager().config.init().value.get('store'),
      organizeService: tree.service as never,
      logger: { warn: vi.fn() },
    });

    const result = await service.commitBatch(batch);
    expect(result.docIds).toHaveLength(2);
    expect(result.warnings).toEqual([]);

    const dbDocId = batch.docs.find(d => d.sourcePath === 'db')!.id;
    const store = collection.getDoc(dbDocId)!.getStore({
      extensions: getStoreManager().config.init().value.get('store'),
    });
    const [dbBlock] = store.getBlocksByFlavour('affine:database');
    expect(dbBlock).toBeTruthy();
    expect((dbBlock.model as any).children).toHaveLength(1);

    // DB doc is placed in the folder created for its parent page.
    const rootFolder = [...tree.nodes.values()].find(
      n => n.type === 'folder' && n.data === 'Root'
    );
    expect(rootFolder).toBeTruthy();
    expect(tree.links).toContainEqual({
      parentId: rootFolder.id,
      docId: dbDocId,
    });
  });
});
