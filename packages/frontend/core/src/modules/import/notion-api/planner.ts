import { sha } from '@blocksuite/affine/global/utils';
import { nanoid } from '@blocksuite/affine/store';
import type {
  ImportBatch,
  ImportBlob,
  ImportDoc,
  ImportFolder,
  ImportIconData,
} from '@blocksuite/affine/widgets/linked-doc';

import {
  type BlockSnapshotLike,
  convertBlocks,
  type ResolvedAsset,
} from './blocks';
import { abortableSleep, isAbortError } from './client';
import { NotionImportWarningCode } from './constants';
import {
  convertCell,
  planDatabaseColumns,
  type PropertyBinding,
} from './properties';
import { plainText, textSnapshot } from './rich-text';
import type {
  NotionBlock,
  NotionDatabase,
  NotionFileObject,
  NotionIcon,
  NotionPage,
  NotionParent,
  NotionSource,
  NotionWarning,
} from './types';

export type DownloadedAsset = { bytes: Uint8Array; mime: string };

export type PlanNotionApiImportOptions = {
  source: NotionSource;
  downloadAsset: (
    url: string,
    signal?: AbortSignal
  ) => Promise<DownloadedAsset>;
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** Warnings produced outside the planner (e.g. rate limiting). */
  warnings?: NotionWarning[];
  assetRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type NotionNodeKind = 'page' | 'database' | 'row';

export type PlannedNode = {
  id: string;
  kind: NotionNodeKind;
  parentId?: string;
};

function parentTarget(
  parent: NotionParent | undefined,
  blockOwners: ReadonlyMap<string, string>
): { id?: string; row?: boolean; unresolved?: boolean } {
  switch (parent?.type) {
    case 'page_id':
      return { id: parent.page_id };
    case 'database_id':
      return { id: parent.database_id, row: true };
    case 'data_source_id':
      return parent.database_id
        ? { id: parent.database_id, row: true }
        : { unresolved: true, row: true };
    case 'block_id': {
      const owner = blockOwners.get(parent.block_id);
      return owner ? { id: owner } : { unresolved: true };
    }
    default:
      return {};
  }
}

/**
 * Reconstructs the parent/child tree for everything visible to the token.
 * Items whose parent is not shared with the integration become roots and
 * produce an `InaccessibleParent` warning.
 */
export function planHierarchy(
  input: {
    pages: NotionPage[];
    databases: NotionDatabase[];
    blockOwners?: ReadonlyMap<string, string>;
  },
  warnings: NotionWarning[]
): Map<string, PlannedNode> {
  const blockOwners = input.blockOwners ?? new Map<string, string>();
  const databaseIds = new Set(input.databases.map(d => d.id));
  const known = new Set([...databaseIds, ...input.pages.map(p => p.id)]);
  const nodes = new Map<string, PlannedNode>();

  const resolve = (
    item: NotionPage | NotionDatabase,
    kind: NotionNodeKind
  ): PlannedNode => {
    const target = parentTarget(item.parent, blockOwners);
    const node: PlannedNode = { id: item.id, kind };
    if (target.id && known.has(target.id) && target.id !== item.id) {
      node.parentId = target.id;
      if (target.row && !databaseIds.has(target.id)) {
        node.parentId = undefined;
      }
    }
    if (!node.parentId && item.parent?.type !== 'workspace') {
      warnings.push({
        code: NotionImportWarningCode.InaccessibleParent,
        message: `The parent of ${kind === 'database' ? 'database' : 'page'} "${
          item.object === 'database'
            ? plainText(item.title) || item.id
            : item.id
        }" is not shared with the integration; it was imported at the top level.`,
        sourcePath: item.id,
      });
    }
    return node;
  };

  for (const database of input.databases) {
    nodes.set(database.id, resolve(database, 'database'));
  }
  for (const page of input.pages) {
    const node = resolve(page, 'page');
    if (node.parentId && databaseIds.has(node.parentId)) node.kind = 'row';
    nodes.set(page.id, node);
  }
  return nodes;
}

function pageTitle(page: NotionPage) {
  for (const value of Object.values(page.properties ?? {})) {
    if (value.type === 'title') return plainText(value.title) || 'Untitled';
  }
  return 'Untitled';
}

function toIcon(icon: NotionIcon): ImportIconData | undefined {
  return icon && icon.type === 'emoji'
    ? { type: 'emoji', unicode: icon.emoji }
    : undefined;
}

function noteWrapper(children: BlockSnapshotLike[]): BlockSnapshotLike {
  return {
    type: 'block',
    id: nanoid(),
    flavour: 'affine:note',
    props: {
      xywh: '[0,0,800,95]',
      background: { light: '#ffffff', dark: '#252525' },
      index: 'a0',
      hidden: false,
      displayMode: 'both',
    },
    children,
  };
}

function docSnapshot(
  id: string,
  title: string,
  createDate: number,
  children: BlockSnapshotLike[]
): ImportDoc['snapshot'] {
  return {
    type: 'page',
    meta: { id, title, createDate, tags: [] },
    blocks: {
      type: 'block',
      id: nanoid(),
      flavour: 'affine:page',
      props: { title: textSnapshot([{ insert: title }]) },
      children: [noteWrapper(children)],
    },
  } as ImportDoc['snapshot'];
}

function collectBlockOwners(
  pageId: string,
  blocks: NotionBlock[],
  owners: Map<string, string>
) {
  for (const block of blocks) {
    owners.set(block.id, pageId);
    if (block.children) collectBlockOwners(pageId, block.children, owners);
  }
}

function toTime(iso?: string) {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? Date.now() : ms;
}

const folderPath = (id: string) => `notion/${id}`;

export async function planNotionApiImport(
  options: PlanNotionApiImportOptions
): Promise<{ batch: ImportBatch }> {
  const { source, signal, onProgress } = options;
  const warnings = options.warnings ?? [];
  const blobs = new Map<string, ImportBlob>();
  const sleep = options.sleep ?? abortableSleep;
  const assetRetries = options.assetRetries ?? 3;
  const checkAbort = () => {
    if (signal?.aborted) {
      throw new DOMException('Import cancelled', 'AbortError');
    }
  };

  const { pages, databases } = await source.listAccessibleContent();
  const total = pages.length * 2 + databases.length;
  let completed = 0;
  const tick = () => onProgress?.({ completed: ++completed, total });
  onProgress?.({ completed, total });

  // Phase 1: fetch the body of every page and index block ownership.
  const bodies = new Map<string, NotionBlock[]>();
  const blockOwners = new Map<string, string>();
  const failed = new Set<string>();
  for (const page of pages) {
    checkAbort();
    try {
      const blocks = await source.getBlocks(page.id);
      bodies.set(page.id, blocks);
      collectBlockOwners(page.id, blocks, blockOwners);
    } catch (error) {
      if (isAbortError(error)) throw error;
      failed.add(page.id);
      warnings.push({
        code: NotionImportWarningCode.ItemFailed,
        message: `Could not read the content of page ${page.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        sourcePath: page.id,
      });
    }
    tick();
  }

  const nodes = planHierarchy({ pages, databases, blockOwners }, warnings);
  const pagesById = new Map(pages.map(p => [p.id, p]));
  const databasesById = new Map(databases.map(d => [d.id, d]));
  const docIds = new Map<string, string>();
  for (const database of databases) docIds.set(database.id, nanoid());
  for (const page of pages) {
    const isRow = nodes.get(page.id)?.kind === 'row';
    if (!isRow || bodies.get(page.id)?.length) docIds.set(page.id, nanoid());
  }
  for (const id of failed) docIds.delete(id);
  const titleOf = (id: string) => {
    const page = pagesById.get(id);
    if (page) return pageTitle(page);
    const database = databasesById.get(id);
    return database ? plainText(database.title) || 'Untitled' : undefined;
  };
  const resolveDocId = (id: string) => docIds.get(id);

  const downloadAsset = async (
    file: NotionFileObject,
    sourcePath: string
  ): Promise<ResolvedAsset | null> => {
    const url = file.type === 'file' ? file.file.url : file.external.url;
    let lastError: unknown;
    for (let attempt = 0; attempt < assetRetries; attempt++) {
      checkAbort();
      try {
        const { bytes, mime } = await options.downloadAsset(url, signal);
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        const blobId = await sha(buffer);
        const name = decodeURIComponent(
          new URL(url).pathname.split('/').pop() || 'file'
        );
        if (!blobs.has(blobId)) {
          blobs.set(blobId, {
            blobId,
            sourcePath: url.split('?')[0],
            fileName: name,
            mime,
            bytes,
          });
        }
        return { blobId, name, mime, size: bytes.byteLength };
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        lastError = error;
        if (attempt < assetRetries - 1) await sleep(500 * 2 ** attempt, signal);
      }
    }
    warnings.push({
      code: NotionImportWarningCode.AssetDownloadFailed,
      message: `Failed to download a file after ${assetRetries} attempts: ${
        lastError instanceof Error ? lastError.message : 'unknown error'
      }`,
      sourcePath,
    });
    return null;
  };

  const convert = (blocks: NotionBlock[], sourcePath: string) =>
    convertBlocks(blocks, {
      resolveDocId,
      downloadAsset,
      warn: warning => warnings.push(warning),
      sourcePath,
    });

  const docs: ImportDoc[] = [];
  const folders: ImportFolder[] = [];
  const addFolder = (
    id: string,
    name: string,
    icon: NotionIcon,
    parentId?: string
  ) => {
    // A row without its own doc is not a valid folder parent.
    const parentDoc = parentId && docIds.has(parentId) ? parentId : undefined;
    folders.push({
      path: folderPath(id),
      name,
      parentPath: parentDoc ? folderPath(parentDoc) : undefined,
      pageId: docIds.get(id),
      icon: toIcon(icon),
    });
  };
  const effectiveParent = (id: string) => {
    let parentId = nodes.get(id)?.parentId;
    while (parentId && !docIds.has(parentId)) {
      parentId = nodes.get(parentId)?.parentId;
    }
    return parentId;
  };

  // Phase 2a: databases -> container doc with a native database block.
  const rowsByDatabase = new Map<string, NotionPage[]>();
  for (const page of pages) {
    const node = nodes.get(page.id);
    if (node?.kind === 'row' && node.parentId) {
      const rows = rowsByDatabase.get(node.parentId) ?? [];
      rows.push(page);
      rowsByDatabase.set(node.parentId, rows);
    }
  }

  for (const database of databases) {
    checkAbort();
    const docId = docIds.get(database.id) ?? nanoid();
    const title = plainText(database.title) || 'Untitled';
    try {
      const { columns, bindings } = planDatabaseColumns(database, warnings);
      const titleBinding = [...bindings.values()].find(
        b => b.columnType === 'title' && !b.fallback
      );
      const titleColumnId =
        titleBinding?.columnId ??
        columns.find(c => c.type === 'title')?.id ??
        '';
      const rowBlocks: BlockSnapshotLike[] = [];
      const cells: Record<string, Record<string, unknown>> = {};
      for (const row of rowsByDatabase.get(database.id) ?? []) {
        const rowTitle = pageTitle(row);
        const rowDocId = docIds.get(row.id);
        const rowBlockId = nanoid();
        rowBlocks.push({
          type: 'block',
          id: rowBlockId,
          flavour: 'affine:paragraph',
          props: {
            type: 'text',
            text: textSnapshot([
              rowDocId
                ? {
                    insert: rowTitle,
                    attributes: {
                      reference: { type: 'LinkedPage', pageId: rowDocId },
                    },
                  }
                : { insert: rowTitle },
            ]),
          },
          children: [],
        });
        const rowCells: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(row.properties ?? {})) {
          const binding: PropertyBinding | undefined = bindings.get(name);
          if (!binding || binding.columnType === 'title') continue;
          const cell = convertCell(binding, value, columns, {
            titleOf,
            resolveDocId,
          });
          if (cell) rowCells[cell.columnId] = cell;
        }
        cells[rowBlockId] = rowCells;
      }
      const databaseBlock: BlockSnapshotLike = {
        type: 'block',
        id: nanoid(),
        flavour: 'affine:database',
        props: {
          views: [
            {
              id: nanoid(),
              name: 'Table View',
              mode: 'table',
              columns: [],
              filter: { type: 'group', op: 'and', conditions: [] },
              header: { titleColumn: titleColumnId, iconColumn: 'type' },
            },
          ],
          title: textSnapshot(title ? [{ insert: title }] : []),
          columns,
          cells,
        },
        children: rowBlocks,
      };
      docs.push({
        id: docId,
        sourcePath: database.id,
        snapshot: docSnapshot(docId, title, toTime(database.created_time), [
          databaseBlock,
        ]),
        meta: {
          title,
          createDate: toTime(database.created_time),
          updatedDate: toTime(database.last_edited_time),
        },
      });
      addFolder(
        database.id,
        title,
        database.icon,
        effectiveParent(database.id)
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      docIds.delete(database.id);
      warnings.push({
        code: NotionImportWarningCode.ItemFailed,
        message: `Failed to import database "${title}": ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        sourcePath: database.id,
      });
    }
    tick();
  }

  // Phase 2b: pages (and bodies of database rows).
  for (const page of pages) {
    checkAbort();
    const docId = docIds.get(page.id);
    if (docId && !failed.has(page.id)) {
      const title = pageTitle(page);
      try {
        const children = await convert(bodies.get(page.id) ?? [], page.id);
        docs.push({
          id: docId,
          sourcePath: page.id,
          snapshot: docSnapshot(
            docId,
            title,
            toTime(page.created_time),
            children
          ),
          meta: {
            title,
            createDate: toTime(page.created_time),
            updatedDate: toTime(page.last_edited_time),
          },
        });
        addFolder(page.id, title, page.icon, effectiveParent(page.id));
      } catch (error) {
        if (isAbortError(error)) throw error;
        warnings.push({
          code: NotionImportWarningCode.ItemFailed,
          message: `Failed to import page "${title}": ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
          sourcePath: page.id,
        });
      }
    }
    tick();
  }

  return {
    batch: {
      docs,
      blobs: Array.from(blobs.values()),
      folders,
      warnings,
      progress: { completed, total },
      done: true,
    },
  };
}
