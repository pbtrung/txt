// Generic cursor-based pagination over any InstaQL top-level query result --
// shared by any admin-SDK query that could return thousands of rows for one
// account (migrate.ts's collectKnownRawPaths, the "which pages does this
// account already have committed" sweep query, is the first case). Kept
// backend/shape-agnostic on purpose: the caller builds its own query for a
// given cursor and pulls {rows, hasNextPage, endCursor} back out of
// whatever shape its own db.query() call returns, so this has no dependency
// on @instantdb/admin's own types (untyped `db: any` throughout this
// codebase already) or on which entity/namespace is being paged through.

export interface InstaqlPage<T> {
  rows: T[];
  hasNextPage: boolean;
  endCursor: unknown;
}

/** Runs `fetchPage(after)` repeatedly (undefined `after` for the first
 * call) until a page reports hasNextPage: false, collecting every row
 * across all pages. `fetchPage` is responsible for building its own query
 * with the given cursor and extracting {rows, hasNextPage, endCursor} from
 * its own db.query() response -- typically `result.pageInfo?.<namespace>`
 * for the latter two. */
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
