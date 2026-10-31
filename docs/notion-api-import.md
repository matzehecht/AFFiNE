# Notion API import

Imports content directly from the Notion API (not an export zip) into the current workspace.
Entry point in the UI: **Import → Notion API (Experimental)**. **Desktop app only** for now (see below).

## For users

1. In Notion, open <https://www.notion.so/profile/integrations> and create an **internal integration**.
2. Copy the integration token (starts with `ntn_` or `secret_`).
3. For every page or database you want to import, open it in Notion → `…` → **Connections** → add your integration.
   Sharing a page also shares its sub-pages.
4. Paste the token in the import dialog and start the import.

Things to know:

- **Scope:** only content shared with the integration is imported. If something is missing, it was not shared.
  Items whose parent is not shared are imported at the top level and a warning is shown.
- **Snapshot:** the import is one-time. Re-importing creates new documents; nothing is synced or updated in place.
- **Foreground:** a progress counter is shown and the import can be cancelled. Cancelling imports nothing; closing the
  app mid-import loses progress (no resume).
- **Databases:** every Notion database becomes a document containing a native AFFiNE database block.
  title, text, number, select/status, multi-select, checkbox, date (start value), URL, email and phone are native columns
  (email/phone are stored as text). Other properties (relation, rollup, formula, people, files, created/edited
  time/by, unique id, …) are imported as plain text columns containing the visible value, and a warning lists them.
  Rows with page content get their own sub-document, linked from the row title.
- **Files and images** are downloaded into AFFiNE blobs. Failed downloads are skipped with a warning.
- Unsupported blocks are skipped with a warning.
- **OAuth** sign-in is planned as a follow-up; the dialog currently shows a placeholder.

## For developers

Code lives in `packages/frontend/core/src/modules/import/notion-api/`.

| File            | Responsibility                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `constants.ts`  | **`NOTION_API_VERSION`** (the single place to bump the API version), base URL, warning codes                                                     |
| `client.ts`     | `NotionApiClient`: search/blocks pagination, retry with backoff for 429 (honours `Retry-After`) and 5xx, `AbortSignal` support, token validation |
| `planner.ts`    | `planNotionApiImport`: builds an `ImportBatch` (docs, blobs, folders, icons, warnings); `planHierarchy`                                          |
| `blocks.ts`     | Notion block → AFFiNE block snapshot mapping, unknown blocks produce a warning                                                                   |
| `properties.ts` | Notion database properties → AFFiNE columns/cells, fallback text formatting                                                                      |
| `importer.ts`   | `runNotionApiImport`: wires client + planner + asset downloads                                                                                   |

The planner returns the same `ImportBatch` used by the zip importers, and `ImportService.importNotionApi` commits it with
`ImportCommitService`, so folder placement, icons and warnings reuse the existing commit path.
The planner only depends on the `NotionSource` interface (`listAccessibleContent`, `getBlocks`), which makes it easy to mock.

Extension points:

- **API version:** change `NOTION_API_VERSION` and re-check the response shapes in `types.ts`
  (e.g. API `2025-09-03` introduces data sources; `parent.data_source_id` is already tolerated).
- **New block types:** add a case in `convertBlock` (`blocks.ts`).
- **New property types:** extend `NATIVE_TYPES` / `convertCell` or `formatFallbackValue` (`properties.ts`).
- **OAuth:** `runNotionApiImport` only needs a bearer token. An OAuth flow can obtain a token and call
  `ImportService.importNotionApi(token)`; the placeholder lives in `NotionApiSetup` (`desktop/dialogs/import/index.tsx`).
  `RunNotionApiImportOptions.fetch`/`baseUrl` can point to a proxy.

Known limitations:

- `api.notion.com` and Notion's signed file hosts do not send CORS headers, so the importer is desktop-only.
  All requests go through the Electron helper (`apps/electron/src/helper/notion`, exposed as `apis.notion.fetch`) via
  `createNativeNotionFetch`. The helper only allows https, never forwards headers to hosts other than `api.notion.com`,
  and rejects private-network hosts. Web support would need a CORS proxy passed as `baseUrl`/`fetch`.
- Blobs are held in memory until commit, like the other zip importers.
- Database fallback columns are plain text, not truly read-only; date ranges keep only the start.
- Out of scope: sync, incremental re-import, resumable imports, OAuth token exchange.

Tests: `yarn vitest run packages/frontend/core/src/modules/import/notion-api`.
