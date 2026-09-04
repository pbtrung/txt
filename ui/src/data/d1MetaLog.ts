// Prints the Worker's per-request D1 query meta (rows_read, rows_written,
// duration, ...) to the browser console -- the browser has no D1 access
// of its own (docs/data_model.md: "Nothing proxies raw SQL to a client"),
// so worker/index.ts collects every env.DB call this request made
// (worker/d1Logging.ts) into this one response header instead. Called
// from every place a /v1/* response is actually read: apiClient.ts's
// fetchSameOrigin() covers the owner's whole REST surface; sharedReader.ts
// calls it directly after its one POST /v1/shared-url, which never goes
// through ApiClient at all.
//
// Mirrors worker/d1Logging.ts's D1_META_HEADER literal -- this module has
// no way to import from the Worker's own separate build, so keep both in
// sync by hand if this ever changes.
const D1_META_HEADER = "X-D1-Meta";

export function logD1QueryMeta(response: Response): void {
  const header = response.headers.get(D1_META_HEADER);
  if (!header) return;
  let queries: unknown;
  try {
    queries = JSON.parse(header);
  } catch {
    return;
  }
  if (!Array.isArray(queries) || queries.length === 0) return;
  console.log(`D1 query meta (${queries.length}):`);
  if (typeof console.table === "function") {
    console.table(queries);
  } else {
    console.log(queries);
  }
}
