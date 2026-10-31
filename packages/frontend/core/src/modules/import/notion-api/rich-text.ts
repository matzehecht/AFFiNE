import type { NotionRichText } from './types';

export type TextDelta = {
  insert: string;
  attributes?: Record<string, unknown>;
};

export type TextSnapshot = {
  '$blocksuite:internal:text$': true;
  delta: TextDelta[];
};

export function plainText(rich: NotionRichText[] | undefined) {
  return (rich ?? []).map(item => item.plain_text).join('');
}

export function textSnapshot(delta: TextDelta[]): TextSnapshot {
  return { '$blocksuite:internal:text$': true, delta };
}

export function richTextToDelta(
  rich: NotionRichText[] | undefined,
  resolveDocId?: (notionId: string) => string | undefined
): TextDelta[] {
  const delta: TextDelta[] = [];
  for (const item of rich ?? []) {
    if (!item.plain_text) continue;
    const attributes: Record<string, unknown> = {};
    const a = item.annotations;
    if (a?.bold) attributes.bold = true;
    if (a?.italic) attributes.italic = true;
    if (a?.strikethrough) attributes.strike = true;
    if (a?.underline) attributes.underline = true;
    if (a?.code) attributes.code = true;

    const mentionedId =
      item.mention?.page?.id ?? item.mention?.database?.id ?? undefined;
    const docId = mentionedId ? resolveDocId?.(mentionedId) : undefined;
    if (docId) {
      attributes.reference = { type: 'LinkedPage', pageId: docId };
    } else if (item.href) {
      attributes.link = item.href;
    }
    delta.push(
      Object.keys(attributes).length
        ? { insert: item.plain_text, attributes }
        : { insert: item.plain_text }
    );
  }
  return delta;
}
