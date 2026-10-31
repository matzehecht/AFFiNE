/**
 * Proxy for the Notion API importer. The Notion API and its signed file hosts
 * do not send CORS headers, so the renderer cannot call them directly; the
 * helper process is not subject to CORS.
 */
const NOTION_API_HOST = 'api.notion.com';
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

export type NotionFetchRequest = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
};

export type NotionFetchResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

function isPrivateHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    /^(fc|fd|fe80)/.test(host) ||
    /^(0|10|127)\./.test(host) ||
    host.startsWith('169.254.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export function assertAllowedNotionUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') {
    throw new Error('Only https URLs are allowed');
  }
  if (url.hostname !== NOTION_API_HOST && isPrivateHost(url.hostname)) {
    throw new Error('Private network addresses are not allowed');
  }
  return url;
}

export const notionHandlers = {
  fetch: async (request: NotionFetchRequest): Promise<NotionFetchResponse> => {
    const url = assertAllowedNotionUrl(request.url);
    const headers: Record<string, string> = {};
    // Credentials are only ever sent to the Notion API itself.
    if (url.hostname === NOTION_API_HOST) {
      Object.assign(headers, request.headers);
    }
    const response = await fetch(url, {
      method: request.method ?? 'GET',
      headers,
      body: request.method === 'POST' ? request.body : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_BODY_BYTES) {
      throw new Error('Response too large');
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  },
};
