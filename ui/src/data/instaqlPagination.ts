// Generic cursor-based pagination over any InstaQL top-level query result --
// browser mirror of txt/instaqlPagination.ts (ui/ and txt/ don't share code
// across their different runtimes/tsconfigs, same as pagePointer.ts/
// base32.ts already don't). Kept backend/shape-agnostic on purpose: the
// caller builds its own query for a given cursor and pulls {rows,
// hasNextPage, endCursor} back out of whatever shape its own
// db.queryOnce() response returns, so this has no dependency on
// @instantdb/react's own types or on which entity/namespace is being paged
// through. instantPageStore.ts's fetchPagesBatch (many page numbers in a
// bounded number of queries, instead of one query per page number) is the
// first user.

export interface InstaqlPage<T> {
  rows: T[];
  hasNextPage: boolean;
  endCursor: unknown;
}

/** Runs `fetchPage(after)` repeatedly (undefined `after` for the first
 * call) until a page reports hasNextPage: false, collecting every row
 * across all pages. `fetchPage` is responsible for building its own query
 * with the given cursor and extracting {rows, hasNextPage, endCursor} from
 * its own db.queryOnce() response -- typically
 * `result.pageInfo?.<namespace>` for the latter two (queryOnce's own
 * response shape is `{data: {...}, pageInfo: {...}}`, siblings -- pageInfo
 * is never nested inside data). */
export async function collectAllPages<T>(
  fetchPage: (after: unknown | undefined) => Promise<InstaqlPage<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let after: unknown | undefined;
  for (;;) {
    const page = await fetchPage(after);
    all.push(...page.rows);
    if (!page.hasNextPage) break;
    after = page.endCursor;
  }
  return all;
}
