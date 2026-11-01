import { describe, expect, test, vi } from 'vitest';

import { NotionApiClient, validateNotionToken } from './client';
import { NOTION_API_VERSION, NotionImportWarningCode } from './constants';

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('NotionApiClient', () => {
  test('sends pinned version header and paginates search', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          results: [{ object: 'page', id: 'p1' }],
          has_more: true,
          next_cursor: 'c1',
        })
      )
      .mockResolvedValueOnce(
        json({
          results: [
            { object: 'database', id: 'd1' },
            { object: 'page', id: 'archived', archived: true },
          ],
          has_more: false,
          next_cursor: null,
        })
      );
    const client = new NotionApiClient({
      token: 'ntn_abcdefghijk',
      fetch: fetchMock,
    });
    const { pages, databases } = await client.listAccessibleContent();
    expect(pages.map(p => p.id)).toEqual(['p1']);
    expect(databases.map(d => d.id)).toEqual(['d1']);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Notion-Version']).toBe(
      NOTION_API_VERSION
    );
    expect(
      JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
    ).toMatchObject({ start_cursor: 'c1' });
  });

  test('retries 429 honoring Retry-After and emits a warning', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })
      )
      .mockResolvedValueOnce(json({ id: 'me' }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onWarning = vi.fn();
    const client = new NotionApiClient({
      token: 'ntn_abcdefghijk',
      fetch: fetchMock,
      sleep,
      onWarning,
    });
    await expect(client.verifyToken()).resolves.toEqual({ id: 'me' });
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ code: NotionImportWarningCode.RateLimited })
    );
  });

  test('retries 5xx with exponential backoff then gives up', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('boom', { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new NotionApiClient({
      token: 'ntn_abcdefghijk',
      fetch: fetchMock,
      sleep,
      maxRetries: 3,
      baseDelayMs: 100,
    });
    await expect(client.verifyToken()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(c => c[0])).toEqual([100, 200, 400]);
  });

  test('does not retry 4xx errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ code: 'unauthorized', message: 'bad token' }, { status: 401 })
      );
    const client = new NotionApiClient({
      token: 'ntn_abcdefghijk',
      fetch: fetchMock,
    });
    await expect(client.verifyToken()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'bad token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('cancels through AbortSignal', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('{}', { status: 500 }));
    const sleep = vi.fn(async () => controller.abort());
    const client = new NotionApiClient({
      token: 'ntn_abcdefghijk',
      fetch: fetchMock,
      sleep,
      signal: controller.signal,
    });
    await expect(client.verifyToken()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('getBlocks resolves nested children but not child pages', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/blocks/page/children')) {
        return json({
          results: [
            { id: 'b1', type: 'toggle', has_children: true },
            { id: 'cp', type: 'child_page', has_children: true },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      return json({
        results: [{ id: 'b2', type: 'paragraph' }],
        has_more: false,
        next_cursor: null,
      });
    });
    const client = new NotionApiClient({
      token: 'ntn_abcdefghijk',
      fetch: fetchMock,
    });
    const blocks = await client.getBlocks('page');
    expect(blocks[0].children?.[0].id).toBe('b2');
    expect(blocks[1].children).toBeUndefined();
  });
});

describe('validateNotionToken', () => {
  test('validates shape', () => {
    expect(validateNotionToken('')).toBe('empty');
    expect(validateNotionToken('ntn_ab cdefghijkl')).toBe('whitespace');
    expect(validateNotionToken('abc')).toBe('format');
    expect(validateNotionToken('  ntn_abcdefghijklmnop ')).toBeNull();
    expect(validateNotionToken('secret_abcdefghijklmnop')).toBeNull();
  });
});
