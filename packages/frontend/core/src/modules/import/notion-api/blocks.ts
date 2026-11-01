import { nanoid } from '@blocksuite/affine/store';

import { NotionImportWarningCode } from './constants';
import {
  plainText,
  richTextToDelta,
  type TextDelta,
  textSnapshot,
} from './rich-text';
import type {
  NotionBlock,
  NotionFileObject,
  NotionRichText,
  NotionWarning,
} from './types';

export type BlockSnapshotLike = {
  type: 'block';
  id: string;
  flavour: string;
  props: Record<string, unknown>;
  children: BlockSnapshotLike[];
};

export type ResolvedAsset = {
  blobId: string;
  name: string;
  mime: string;
  size: number;
};

export type BlockConvertContext = {
  resolveDocId: (notionId: string) => string | undefined;
  downloadAsset: (
    file: NotionFileObject,
    sourcePath: string
  ) => Promise<ResolvedAsset | null>;
  warn: (warning: NotionWarning) => void;
  sourcePath: string;
};

const CONTAINER_ONLY = new Set([
  'column_list',
  'column',
  'synced_block',
  'table',
  'template',
]);
const SILENTLY_SKIPPED = new Set(['breadcrumb', 'table_of_contents']);
const ATTACHMENT_TYPES = new Set(['file', 'pdf', 'audio', 'video']);
const NOTE_CHILD_FLAVOURS = new Set(['affine:paragraph', 'affine:list']);

function block(
  flavour: string,
  props: Record<string, unknown>,
  children: BlockSnapshotLike[] = []
): BlockSnapshotLike {
  return { type: 'block', id: nanoid(), flavour, props, children };
}

function textBlock(
  type: string,
  delta: TextDelta[],
  children: BlockSnapshotLike[] = []
) {
  return block(
    'affine:paragraph',
    { type, text: textSnapshot(delta) },
    children
  );
}

function fileUrl(file: NotionFileObject) {
  return file.type === 'file' ? file.file.url : file.external.url;
}

function fileName(file: NotionFileObject, fallback: string) {
  if (file.name) return file.name;
  try {
    const last = new URL(fileUrl(file)).pathname.split('/').pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // ignore
  }
  return fallback;
}

function normalizeLanguage(language?: string) {
  if (!language || language === 'plain text') return null;
  return language.toLowerCase();
}

export async function convertBlocks(
  blocks: NotionBlock[],
  ctx: BlockConvertContext
): Promise<BlockSnapshotLike[]> {
  const out: BlockSnapshotLike[] = [];
  for (const source of blocks) {
    out.push(...(await convertBlock(source, ctx)));
  }
  return out;
}

async function convertBlock(
  source: NotionBlock,
  ctx: BlockConvertContext
): Promise<BlockSnapshotLike[]> {
  const data = source[source.type] ?? {};
  const rich = (data.rich_text ?? []) as NotionRichText[];
  const delta = () => richTextToDelta(rich, ctx.resolveDocId);
  const children = () => convertBlocks(source.children ?? [], ctx);

  switch (source.type) {
    case 'paragraph':
      return [textBlock('text', delta(), await children())];
    case 'heading_1':
    case 'heading_2':
    case 'heading_3': {
      const level = source.type.slice(-1);
      return [textBlock(`h${level}`, delta(), await children())];
    }
    case 'quote':
      return [textBlock('quote', delta(), await children())];
    case 'toggle':
      return [textBlock('text', delta(), await children())];
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'to_do':
      return [
        block(
          'affine:list',
          {
            type:
              source.type === 'to_do'
                ? 'todo'
                : source.type === 'numbered_list_item'
                  ? 'numbered'
                  : 'bulleted',
            text: textSnapshot(delta()),
            checked: source.type === 'to_do' && !!data.checked,
            collapsed: false,
            order: null,
          },
          await children()
        ),
      ];
    case 'callout': {
      const nested = await children();
      const allowed = nested.filter(c => NOTE_CHILD_FLAVOURS.has(c.flavour));
      const rest = nested.filter(c => !NOTE_CHILD_FLAVOURS.has(c.flavour));
      const icon =
        data.icon?.type === 'emoji'
          ? { type: 'emoji', unicode: data.icon.emoji }
          : undefined;
      return [
        block(
          'affine:callout',
          { text: textSnapshot(delta()), ...(icon ? { icon } : {}) },
          allowed
        ),
        ...rest,
      ];
    }
    case 'code':
      return [
        block('affine:code', {
          text: textSnapshot(delta()),
          language: normalizeLanguage(data.language),
          wrap: false,
          caption: plainText(data.caption),
        }),
      ];
    case 'equation':
      return [
        textBlock('text', [
          { insert: data.expression ?? '', attributes: { code: true } },
        ]),
      ];
    case 'divider':
      return [block('affine:divider', {})];
    case 'image': {
      const asset = await ctx.downloadAsset(data, ctx.sourcePath);
      if (!asset) return [];
      return [
        block('affine:image', {
          sourceId: asset.blobId,
          caption: plainText(data.caption),
          size: asset.size,
          width: 0,
          height: 0,
          rotate: 0,
          index: 'a0',
          xywh: '[0,0,0,0]',
        }),
      ];
    }
    case 'bookmark':
    case 'embed':
    case 'link_preview': {
      const url = data.url as string | undefined;
      if (!url) return [];
      return [bookmark(url, plainText(data.caption))];
    }
    case 'child_page':
    case 'child_database': {
      const docId = ctx.resolveDocId(source.id);
      const title = data.title ?? '';
      if (!docId) return title ? [textBlock('text', [{ insert: title }])] : [];
      return [
        textBlock('text', [
          {
            insert: ' ',
            attributes: { reference: { type: 'LinkedPage', pageId: docId } },
          },
        ]),
      ];
    }
    case 'table_row': {
      const cells = (data.cells ?? []) as NotionRichText[][];
      return [
        textBlock('text', [{ insert: cells.map(plainText).join(' | ') }]),
      ];
    }
    default:
      break;
  }

  if (ATTACHMENT_TYPES.has(source.type)) {
    if (data.type === 'external' && source.type === 'video') {
      return [bookmark(data.external.url, plainText(data.caption))];
    }
    const asset = await ctx.downloadAsset(data, ctx.sourcePath);
    if (!asset) return [];
    return [
      block('affine:attachment', {
        name: fileName(data, asset.name),
        size: asset.size,
        type: asset.mime,
        sourceId: asset.blobId,
        caption: plainText(data.caption),
        embed: false,
        style: 'horizontalThin',
        footnoteIdentifier: null,
        index: 'a0',
        xywh: '[0,0,0,0]',
        rotate: 0,
      }),
    ];
  }

  if (CONTAINER_ONLY.has(source.type)) return children();
  if (SILENTLY_SKIPPED.has(source.type)) return [];

  ctx.warn({
    code: NotionImportWarningCode.UnsupportedBlock,
    message: `Skipped unsupported Notion block type "${source.type}" (${source.id}).`,
    sourcePath: ctx.sourcePath,
  });
  return [];
}

function bookmark(url: string, caption: string) {
  return block('affine:bookmark', {
    url,
    style: 'horizontal',
    caption: caption || null,
    title: null,
    description: null,
    icon: null,
    image: null,
    footnoteIdentifier: null,
    index: 'a0',
    xywh: '[0,0,0,0]',
    rotate: 0,
  });
}
