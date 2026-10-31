/**
 * The single place that pins the Notion API version used by the importer.
 * To adopt a newer version, update this constant and re-check the response
 * shapes declared in `types.ts` (e.g. 2025-09-03 introduces data sources).
 */
export const NOTION_API_VERSION = '2022-06-28';

export const NOTION_API_BASE_URL = 'https://api.notion.com';

export const NotionImportWarningCode = {
  InaccessibleParent: 'notion_inaccessible_parent',
  UnsupportedBlock: 'notion_unsupported_block',
  UnsupportedProperty: 'notion_unsupported_property',
  AssetDownloadFailed: 'notion_asset_download_failed',
  RateLimited: 'notion_rate_limited',
  ItemFailed: 'notion_item_failed',
} as const;
