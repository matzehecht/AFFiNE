import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  assertAllowedNotionUrl,
  notionHandlers,
} from '../../src/helper/notion';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notion helper proxy', () => {
  test('only allows public https urls', () => {
    expect(() =>
      assertAllowedNotionUrl('https://api.notion.com/v1/search')
    ).not.toThrow();
    expect(() =>
      assertAllowedNotionUrl('https://s3.example.com/a.png')
    ).not.toThrow();
    expect(() => assertAllowedNotionUrl('http://api.notion.com')).toThrow();
    expect(() => assertAllowedNotionUrl('https://localhost/x')).toThrow();
    expect(() => assertAllowedNotionUrl('https://192.168.1.2/x')).toThrow();
    expect(() => assertAllowedNotionUrl('https://169.254.169.254/x')).toThrow();
  });

  test('forwards headers only to the Notion API host', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const headers = { authorization: '******' };
    await notionHandlers.fetch({
      url: 'https://api.notion.com/v1/users/me',
      headers,
    });
    await notionHandlers.fetch({
      url: 'https://files.example.com/a.png',
      headers,
    });
    const calls = fetchMock.mock.calls as unknown as [unknown, RequestInit][];
    expect(calls[0][1].headers).toEqual(headers);
    expect(calls[1][1].headers).toEqual({});
  });
});
