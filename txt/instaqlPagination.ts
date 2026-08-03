// Generic pagination loop over any InstaQL top-level query result -- shared
// by any admin-SDK query that could return thousands of rows for one
// account (migrate.ts's/collectGarbage.ts's own collectKnownRawPaths are
// current callers). Kept backend/shape-agnostic on purpose: the caller
// builds its own query for a given `after` value and pulls
// {rows, hasNextPage, endCursor} back out of whatever shape its own
// db.query() call returns, so this has no dependency on @instantdb/admin's
// own types (untyped `db: any` throughout this codebase already) or on
// which entity/namespace is being paged through.
//
// IMPORTANT for Admin-SDK callers specifically (confirmed against the real
// @instantdb/admin package): its query() has no pageInfo/cursor concept at
// all -- that's purely a client-SDK (@instantdb/core's Reactor) feature,
// confirmed absent from admin's own type declarations and JS
// implementation (a plain passthrough of whatever POST /admin/query
// returns, no pageInfo anywhere in that response). A caller that assumes a
// real server-provided cursor here will see hasNextPage always come back
// false and silently stop after the first page. Use InstaQL's own
// documented offset-based pagination instead: treat `after` as a plain
// numeric offset (0 on the first call), request `limit` via the query's own
// $ clause, and derive hasNextPage/endCursor heuristically --
// `rows.length === limit` (a full page came back, there's probably more)
// and `endCursor = offset + rows.length` (the next offset to use).

export interface InstaqlPage<T> {
  rows: T[];
  hasNextPage: boolean;
  endCursor: unknown;
}

/** Runs `fetchPage(after)` repeatedly (undefined `after` for the first
 * call) until a page reports hasNextPage: false, collecting every row
 * across all pages. `fetchPage` is responsible for building its own query
 * with the given `after` and extracting {rows, hasNextPage, endCursor} from
 * its own db.query() response -- for an Admin SDK caller, that means
 * treating `after` as a plain numeric offset and deriving hasNextPage/
 * endCursor from the returned row count yourself (see this file's header
 * comment), not from a `pageInfo` field, which admin queries never have. */
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
