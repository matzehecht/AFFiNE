import { apis } from '@affine/electron-api';

function abortError() {
  return new DOMException('Import cancelled', 'AbortError');
}

/**
 * `fetch` replacement that goes through the Electron helper process, because
 * the Notion API and its file hosts do not allow cross-origin browser requests.
 */
export function createNativeNotionFetch(): typeof fetch {
  return async (input, init) => {
    const notion = apis?.notion;
    if (!notion) {
      throw new Error(
        'The Notion importer is only available in the desktop app.'
      );
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call = notion.fetch({
      url: String(input),
      method: init?.method === 'POST' ? 'POST' : 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const aborted = new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()), {
        once: true,
      });
    });
    const result = await Promise.race([call, aborted]);
    const body = new Uint8Array(result.body);
    return new Response([204, 205, 304].includes(result.status) ? null : body, {
      status: result.status,
      headers: result.headers,
    });
  };
}
