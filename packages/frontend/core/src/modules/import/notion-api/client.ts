import {
  NOTION_API_BASE_URL,
  NOTION_API_VERSION,
  NotionImportWarningCode,
} from './constants';
import type {
  NotionBlock,
  NotionDatabase,
  NotionPage,
  NotionSource,
  NotionWarning,
} from './types';

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

export type NotionClientOptions = {
  token: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onWarning?: (warning: NotionWarning) => void;
};

const NO_RETRY_BODY_LIMIT = 500;
const NON_CONTAINER_BLOCKS = new Set(['child_page', 'child_database']);

function abortError() {
  return new DOMException('Import cancelled', 'AbortError');
}

export function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Basic client-side token shape check; the real check is `verifyToken`. */
export function validateNotionToken(token: string): string | null {
  const value = token.trim();
  if (!value) return 'empty';
  if (/\s/.test(value)) return 'whitespace';
  if (!/^(secret_|ntn_)[A-Za-z0-9_-]{10,}$/.test(value)) return 'format';
  return null;
}

export class NotionApiClient implements NotionSource {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: NotionClientOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.baseUrl = (options.baseUrl ?? NOTION_API_BASE_URL).replace(/\/$/, '');
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<T> {
    const { signal, token } = this.options;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortError();
      let response: Response | undefined;
      let networkError: unknown;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          signal,
          headers: {
            Authorization: ['Bearer', token].join(' '),
            'Notion-Version': NOTION_API_VERSION,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw abortError();
        networkError = error;
      }

      const retryable =
        !response ||
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599);
      if (response?.ok) return (await response.json()) as T;

      if (!retryable || attempt >= this.maxRetries) {
        if (!response) {
          throw new NotionApiError(
            `Network error while contacting Notion: ${
              networkError instanceof Error ? networkError.message : 'unknown'
            }`,
            0
          );
        }
        const text = await response.text().catch(() => '');
        let code: string | undefined;
        let message = text.slice(0, NO_RETRY_BODY_LIMIT);
        try {
          const json = JSON.parse(text);
          code = json.code;
          message = json.message ?? message;
        } catch {
          // not JSON
        }
        throw new NotionApiError(
          message || `Notion API request failed (${response.status})`,
          response.status,
          code
        );
      }

      const retryAfter = Number(response?.headers.get('Retry-After'));
      const backoff = Math.min(
        this.maxDelayMs,
        this.baseDelayMs * 2 ** attempt
      );
      const delay =
        response?.status === 429 &&
        Number.isFinite(retryAfter) &&
        retryAfter > 0
          ? Math.min(retryAfter * 1000, this.maxDelayMs)
          : backoff;
      if (response?.status === 429) {
        this.options.onWarning?.({
          code: NotionImportWarningCode.RateLimited,
          message: `Notion rate limit hit on ${path}; retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt + 1}/${this.maxRetries}).`,
          sourcePath: path,
        });
      }
      await this.sleep(delay, signal);
    }
  }

  async verifyToken() {
    return this.request<{ id: string }>('GET', '/v1/users/me');
  }

  private async paginate<T>(
    fetchPage: (cursor?: string) => Promise<{
      results: T[];
      has_more: boolean;
      next_cursor: string | null;
    }>
  ) {
    const all: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor);
      all.push(...page.results);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return all;
  }

  async listAccessibleContent() {
    const results = await this.paginate<NotionPage | NotionDatabase>(cursor =>
      this.request('POST', '/v1/search', {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
    );
    const live = results.filter(item => !item.archived && !item.in_trash);
    return {
      pages: live.filter((r): r is NotionPage => r.object === 'page'),
      databases: live.filter(
        (r): r is NotionDatabase => r.object === 'database'
      ),
    };
  }

  /** Fetches the block tree of a page, resolving nested children. */
  async getBlocks(blockId: string): Promise<NotionBlock[]> {
    const blocks = await this.paginate<NotionBlock>(cursor =>
      this.request(
        'GET',
        `/v1/blocks/${blockId}/children?page_size=100${
          cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''
        }`
      )
    );
    for (const block of blocks) {
      if (block.has_children && !NON_CONTAINER_BLOCKS.has(block.type)) {
        block.children = await this.getBlocks(block.id);
      }
    }
    return blocks;
  }
}
