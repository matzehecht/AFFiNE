import { describe, expect, test } from 'vitest';

import { NotionImportWarningCode } from './constants';
import {
  convertCell,
  formatFallbackValue,
  planDatabaseColumns,
} from './properties';
import type { NotionDatabase, NotionWarning } from './types';

const database = {
  object: 'database',
  id: 'db',
  parent: { type: 'workspace' },
  title: [{ type: 'text', plain_text: 'Tasks' }],
  properties: {
    Name: { id: 't', name: 'Name', type: 'title' },
    Notes: { id: 'n', name: 'Notes', type: 'rich_text' },
    Count: { id: 'c', name: 'Count', type: 'number' },
    Status: {
      id: 's',
      name: 'Status',
      type: 'select',
      select: { options: [{ name: 'Todo', color: 'red' }] },
    },
    Tags: {
      id: 'm',
      name: 'Tags',
      type: 'multi_select',
      multi_select: { options: [{ name: 'a' }] },
    },
    Done: { id: 'd', name: 'Done', type: 'checkbox' },
    When: { id: 'w', name: 'When', type: 'date' },
    Site: { id: 'u', name: 'Site', type: 'url' },
    Mail: { id: 'e', name: 'Mail', type: 'email' },
    Tel: { id: 'p', name: 'Tel', type: 'phone_number' },
    Rel: { id: 'r', name: 'Rel', type: 'relation' },
    Sum: { id: 'x', name: 'Sum', type: 'rollup' },
    Who: { id: 'o', name: 'Who', type: 'people' },
  },
} as unknown as NotionDatabase;

describe('planDatabaseColumns', () => {
  test('maps supported types natively and falls back for others', () => {
    const warnings: NotionWarning[] = [];
    const { columns, bindings } = planDatabaseColumns(database, warnings);
    const type = (name: string) => bindings.get(name)?.columnType;
    expect(type('Name')).toBe('title');
    expect(type('Notes')).toBe('rich-text');
    expect(type('Count')).toBe('number');
    expect(type('Status')).toBe('select');
    expect(type('Tags')).toBe('multi-select');
    expect(type('Done')).toBe('checkbox');
    expect(type('When')).toBe('date');
    expect(type('Site')).toBe('link');
    expect(bindings.get('Rel')?.fallback).toBe(true);
    expect(bindings.get('Mail')?.fallback).toBe(false);
    expect(columns).toHaveLength(Object.keys(database.properties).length);
    const statusOptions = (columns.find(c => c.name === 'Status')?.data
      .options ?? []) as any[];
    expect(statusOptions[0]).toMatchObject({
      value: 'Todo',
      color: 'var(--affine-tag-red)',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(NotionImportWarningCode.UnsupportedProperty);
    expect(warnings[0].message).toContain('Rel (relation)');
    expect(warnings[0].message).toContain('Who (people)');
  });

  test('adds a title column when the schema has none', () => {
    const { columns } = planDatabaseColumns(
      { ...database, properties: {} },
      []
    );
    expect(columns.map(c => c.type)).toEqual(['title']);
  });
});

describe('convertCell', () => {
  const { columns, bindings } = planDatabaseColumns(database, []);
  const cell = (name: string, value: any) =>
    convertCell(bindings.get(name)!, value, columns);

  test('converts native values', () => {
    expect(cell('Count', { type: 'number', number: 4 })?.value).toBe(4);
    expect(cell('Done', { type: 'checkbox', checkbox: true })?.value).toBe(
      true
    );
    expect(
      cell('When', { type: 'date', date: { start: '2024-01-02' } })?.value
    ).toBe(Date.parse('2024-01-02'));
    expect(cell('Site', { type: 'url', url: 'https://a.b' })?.value).toBe(
      'https://a.b'
    );
    expect(cell('Count', { type: 'number', number: null })).toBeNull();
    const optionId = bindings.get('Status')!.optionIdByName!.get('Todo');
    expect(
      cell('Status', { type: 'select', select: { name: 'Todo' } })?.value
    ).toBe(optionId);
  });

  test('creates missing select options on demand', () => {
    const value = cell('Tags', {
      type: 'multi_select',
      multi_select: [{ name: 'a' }, { name: 'new' }],
    })?.value as string[];
    expect(value).toHaveLength(2);
    const tags = columns.find(c => c.name === 'Tags')!;
    expect((tags.data.options as any[]).map(o => o.value)).toEqual([
      'a',
      'new',
    ]);
  });

  test('stores fallback values as text', () => {
    const result = cell('Who', {
      type: 'people',
      people: [{ id: '1', name: 'Ann' }, { id: '2' }],
    });
    expect(result?.value).toMatchObject({
      delta: [{ insert: 'Ann, 2' }],
    });
  });
});

describe('formatFallbackValue', () => {
  test('formats complex values', () => {
    expect(
      formatFallbackValue(
        { type: 'relation', relation: [{ id: 'a' }, { id: 'b' }] },
        { titleOf: id => (id === 'a' ? 'Page A' : undefined) }
      )
    ).toBe('Page A, b');
    expect(
      formatFallbackValue({
        type: 'formula',
        formula: { type: 'boolean', boolean: true },
      })
    ).toBe('true');
    expect(
      formatFallbackValue({
        type: 'rollup',
        rollup: { type: 'array', array: [{ type: 'number', number: 1 }] },
      })
    ).toBe('1');
    expect(
      formatFallbackValue({
        type: 'files',
        files: [{ name: 'a.pdf', file: { url: 'https://x/expiring' } }],
      })
    ).toBe('a.pdf');
    expect(
      formatFallbackValue({
        type: 'unique_id',
        unique_id: { prefix: 'T', number: 5 },
      })
    ).toBe('T-5');
  });
});
