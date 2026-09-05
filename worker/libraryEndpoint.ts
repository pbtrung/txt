// GET /v1/library: the Library screen's one-request combination of the
// three read-only, Access-only queries its reload() needs on every load
// -- the recently-accessed listing (documentsEndpoint.ts), the singleton
// catalog row (catalogEndpoint.ts), and the bookmarks summary
// (bookmarksEndpoint.ts). Each used to be its own /v1/* route, and
// Cloudflare bills a Worker by request count as well as CPU time
// (docs/deployment.md §8) -- three separate fetches on every Library load
// billed as three requests for data that's always needed together.
// env.DB.batch() also collapses the three D1 queries into one D1 round
// trip. GET /v1/bookmarks/summary keeps its own route: it's also called
// alone after creating or deleting a single bookmark
// (ui/src/data/libraryStore.ts's reloadBookmarksSummary()), which doesn't
// need the other two queries re-run.
import {
  RECENT_ACCESS_QUERY,
  documentJson,
  type DocumentRow,
} from "./documentsEndpoint";
import { CATALOG_QUERY, catalogJson, type CatalogRow } from "./catalogEndpoint";
import {
  BOOKMARKS_SUMMARY_QUERY,
  bookmarkSummaryJson,
  type BookmarkSummaryRow,
} from "./bookmarksEndpoint";

export async function handleGetLibrary(env: Env): Promise<Response> {
  const [documentsResult, catalogResult, summaryResult] = await env.DB.batch([
    env.DB.prepare(RECENT_ACCESS_QUERY),
    env.DB.prepare(CATALOG_QUERY),
    env.DB.prepare(BOOKMARKS_SUMMARY_QUERY),
  ]);
  const catalogRow = (catalogResult.results as CatalogRow[])[0];
  return Response.json({
    documents: (documentsResult.results as DocumentRow[]).map(documentJson),
    catalog: catalogRow ? catalogJson(catalogRow) : null,
    summaries: (summaryResult.results as BookmarkSummaryRow[]).map(bookmarkSummaryJson),
  });
}
