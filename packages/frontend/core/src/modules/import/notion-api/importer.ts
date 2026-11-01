import { NotionApiClient, validateNotionToken } from './client';
import { planNotionApiImport } from './planner';
import type { NotionWarning } from './types';

export type RunNotionApiImportOptions = {
  token: string;
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** Override for tests or for a CORS proxy in front of the Notion API. */
  fetch?: typeof fetch;
  baseUrl?: string;
};

export async function downloadNotionAsset(
  url: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
) {
  // Signed Notion file URLs must not receive the integration token.
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mime =
    response.headers.get('content-type')?.split(';')[0].trim() ||
    'application/octet-stream';
  return { bytes, mime };
}

/**
 * Entry point of the Notion API importer: verifies the token, reads all
 * content visible to it and plans an `ImportBatch` that can be committed with
 * `ImportCommitService`.
 */
export async function runNotionApiImport(options: RunNotionApiImportOptions) {
  if (validateNotionToken(options.token)) {
    throw new Error('Invalid Notion integration token.');
  }
  const warnings: NotionWarning[] = [];
  const client = new NotionApiClient({
    token: options.token.trim(),
    signal: options.signal,
    fetch: options.fetch,
    baseUrl: options.baseUrl,
    onWarning: warning => warnings.push(warning),
  });
  await client.verifyToken();
  return planNotionApiImport({
    source: client,
    signal: options.signal,
    onProgress: options.onProgress,
    warnings,
    downloadAsset: (url, signal) =>
      downloadNotionAsset(url, signal, options.fetch),
  });
}
