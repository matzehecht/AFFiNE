import { nanoid } from '@blocksuite/affine/store';

import { NotionImportWarningCode } from './constants';
import { plainText, richTextToDelta, textSnapshot } from './rich-text';
import type {
  NotionDatabase,
  NotionPropertySchema,
  NotionPropertyValue,
  NotionRichText,
  NotionSelectOption,
  NotionWarning,
} from './types';

/** Notion property types that map onto native AFFiNE database columns. */
export type NativeColumnType =
  | 'title'
  | 'rich-text'
  | 'number'
  | 'select'
  | 'multi-select'
  | 'checkbox'
  | 'date'
  | 'link';

export type ColumnSnapshot = {
  id: string;
  type: string;
  name: string;
  data: Record<string, unknown>;
};

export type PropertyBinding = {
  propertyName: string;
  notionType: string;
  columnId: string;
  columnType: NativeColumnType;
  /** True when the Notion type has no native column and is stored as text. */
  fallback: boolean;
  optionIdByName?: Map<string, string>;
};

const TAG_COLORS = [
  'blue',
  'green',
  'teal',
  'purple',
  'red',
  'pink',
  'yellow',
  'orange',
  'gray',
  'white',
];

const NOTION_COLOR_TO_TAG: Record<string, string> = {
  default: 'gray',
  gray: 'gray',
  brown: 'orange',
  orange: 'orange',
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
  purple: 'purple',
  pink: 'pink',
  red: 'red',
};

const NATIVE_TYPES: Record<string, NativeColumnType> = {
  title: 'title',
  rich_text: 'rich-text',
  number: 'number',
  select: 'select',
  status: 'select',
  multi_select: 'multi-select',
  checkbox: 'checkbox',
  date: 'date',
  url: 'link',
  // AFFiNE has no dedicated email/phone columns; kept as editable text.
  email: 'rich-text',
  phone_number: 'rich-text',
};

function tagColor(option: NotionSelectOption, index: number) {
  const name =
    (option.color && NOTION_COLOR_TO_TAG[option.color]) ??
    TAG_COLORS[index % TAG_COLORS.length];
  return `var(--affine-tag-${name})`;
}

function schemaOptions(schema: NotionPropertySchema): NotionSelectOption[] {
  return (
    schema.select?.options ??
    schema.multi_select?.options ??
    schema.status?.options ??
    []
  );
}

export function planDatabaseColumns(
  database: NotionDatabase,
  warnings: NotionWarning[]
) {
  const columns: ColumnSnapshot[] = [];
  const bindings = new Map<string, PropertyBinding>();
  const fallbacks: string[] = [];
  let hasTitle = false;

  for (const [propertyName, schema] of Object.entries(database.properties)) {
    const native = NATIVE_TYPES[schema.type];
    const columnId = nanoid();
    const columnType: NativeColumnType = native ?? 'rich-text';
    const binding: PropertyBinding = {
      propertyName,
      notionType: schema.type,
      columnId,
      columnType,
      fallback: !native,
    };
    const column: ColumnSnapshot = {
      id: columnId,
      type: columnType,
      name: schema.name || propertyName,
      data: {},
    };
    if (columnType === 'select' || columnType === 'multi-select') {
      binding.optionIdByName = new Map();
      column.data = {
        options: schemaOptions(schema).map((option, index) => {
          const id = nanoid();
          binding.optionIdByName?.set(option.name, id);
          return { id, value: option.name, color: tagColor(option, index) };
        }),
      };
    } else if (columnType === 'number') {
      column.data = { decimal: 0 };
    }
    if (columnType === 'title') {
      if (hasTitle) {
        binding.fallback = true;
        binding.columnType = 'rich-text';
        column.type = 'rich-text';
      } else {
        hasTitle = true;
      }
    }
    if (binding.fallback) fallbacks.push(`${propertyName} (${schema.type})`);
    columns.push(column);
    bindings.set(propertyName, binding);
  }

  if (!hasTitle) {
    columns.unshift({ id: nanoid(), type: 'title', name: 'Name', data: {} });
  }

  if (fallbacks.length) {
    warnings.push({
      code: NotionImportWarningCode.UnsupportedProperty,
      message: `Database "${plainText(database.title) || database.id}": ${fallbacks.length} propert${
        fallbacks.length === 1 ? 'y was' : 'ies were'
      } imported as plain text columns (${fallbacks.join(', ')}). Values are a snapshot and are not kept in sync.`,
      sourcePath: database.id,
    });
  }
  return { columns, bindings };
}

type FormatContext = {
  /** Resolves a Notion id (e.g. a relation target) to a display title. */
  titleOf?: (notionId: string) => string | undefined;
};

function formatDate(date?: { start?: string; end?: string | null } | null) {
  if (!date?.start) return '';
  return date.end ? `${date.start} → ${date.end}` : date.start;
}

function formatUser(user: any) {
  return user?.name ?? user?.id ?? '';
}

function formatFile(file: any) {
  // Notion-hosted file URLs expire, so only the name is preserved.
  return file?.name ?? file?.external?.url ?? '';
}

/** Human-readable text for property types without a native column. */
export function formatFallbackValue(
  value: NotionPropertyValue,
  ctx: FormatContext = {}
): string {
  const data = value[value.type];
  switch (value.type) {
    case 'relation':
      return ((data as { id: string }[]) ?? [])
        .map(item => ctx.titleOf?.(item.id) ?? item.id)
        .join(', ');
    case 'rollup': {
      switch (data?.type) {
        case 'number':
          return data.number == null ? '' : String(data.number);
        case 'date':
          return formatDate(data.date);
        case 'array':
          return ((data.array as NotionPropertyValue[]) ?? [])
            .map(item => formatFallbackValue(item, ctx))
            .filter(Boolean)
            .join(', ');
        default:
          return '';
      }
    }
    case 'formula': {
      switch (data?.type) {
        case 'string':
          return data.string ?? '';
        case 'number':
          return data.number == null ? '' : String(data.number);
        case 'boolean':
          return data.boolean ? 'true' : 'false';
        case 'date':
          return formatDate(data.date);
        default:
          return '';
      }
    }
    case 'people':
      return ((data as any[]) ?? []).map(formatUser).filter(Boolean).join(', ');
    case 'files':
      return ((data as any[]) ?? []).map(formatFile).filter(Boolean).join(', ');
    case 'created_by':
    case 'last_edited_by':
      return formatUser(data);
    case 'created_time':
    case 'last_edited_time':
      return data ?? '';
    case 'unique_id':
      return data
        ? `${data.prefix ? `${data.prefix}-` : ''}${data.number ?? ''}`
        : '';
    case 'verification':
      return data?.state ?? '';
    case 'button':
      return '';
    default:
      return typeof data === 'string' || typeof data === 'number'
        ? String(data)
        : '';
  }
}

export type DatabaseCell = { columnId: string; value: unknown };

function selectOptionId(
  binding: PropertyBinding,
  columns: ColumnSnapshot[],
  option: NotionSelectOption
) {
  let id = binding.optionIdByName?.get(option.name);
  if (!id) {
    id = nanoid();
    binding.optionIdByName?.set(option.name, id);
    const column = columns.find(c => c.id === binding.columnId);
    const options = ((column?.data.options as unknown[]) ?? []) as unknown[];
    options.push({
      id,
      value: option.name,
      color: tagColor(option, options.length),
    });
    if (column) column.data.options = options;
  }
  return id;
}

/** Converts one Notion property value into an AFFiNE cell (or null if empty). */
export function convertCell(
  binding: PropertyBinding,
  value: NotionPropertyValue | undefined,
  columns: ColumnSnapshot[],
  ctx: FormatContext & {
    resolveDocId?: (id: string) => string | undefined;
  } = {}
): DatabaseCell | null {
  if (!value) return null;
  const { columnId } = binding;
  const data = value[value.type];
  const text = (str: string) =>
    str ? { columnId, value: textSnapshot([{ insert: str }]) } : null;

  if (binding.fallback) return text(formatFallbackValue(value, ctx));

  switch (binding.columnType) {
    case 'rich-text': {
      if (value.type === 'rich_text') {
        const delta = richTextToDelta(
          data as NotionRichText[],
          ctx.resolveDocId
        );
        return delta.length ? { columnId, value: textSnapshot(delta) } : null;
      }
      return text(typeof data === 'string' ? data : '');
    }
    case 'number':
      return typeof data === 'number' ? { columnId, value: data } : null;
    case 'select':
      return data?.name
        ? { columnId, value: selectOptionId(binding, columns, data) }
        : null;
    case 'multi-select': {
      const options = (data as NotionSelectOption[]) ?? [];
      return options.length
        ? {
            columnId,
            value: options.map(o => selectOptionId(binding, columns, o)),
          }
        : null;
    }
    case 'checkbox':
      return { columnId, value: !!data };
    case 'date': {
      const ms = data?.start ? Date.parse(data.start) : NaN;
      return Number.isNaN(ms) ? null : { columnId, value: ms };
    }
    case 'link':
      return typeof data === 'string' && data
        ? { columnId, value: data }
        : null;
    default:
      return null;
  }
}
