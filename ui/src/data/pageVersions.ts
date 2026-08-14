// AA queries for opening BB (docs/data_model.md §6.1): reading head_version,
// pinning a snapshot, and resolving the live page map -- either via the
// bundle+AA-delta path or a full paginated scan when no bundle exists yet
// -- plus fetching the actual ciphertext bytes for whichever pages the
// bundle's own hot-pages section didn't already provide.
import type { Aa } from "./session";

export interface HeadVersion {
  version: number;
  pageCount: number;
}

export async function readHeadVersion(aa: Aa): Promise<HeadVersion> {
  const metaRows = await aa.query("SELECT head_version FROM meta WHERE id = 1");
  if (metaRows.length === 0) throw new Error("meta row missing; run --init-db first");
  const version = metaRows[0][0] as number;
  const versionRows = await aa.query("SELECT page_count FROM versions WHERE version = ?", [version]);
  return { version, pageCount: versionRows.length > 0 ? (versionRows[0][0] as number) : 0 };
}

/** Pins `version` against garbage collection for the life of this BB open.
 * Not heartbeated yet (docs/data_model.md's 30s interval) -- a real gap if
 * --collect-garbage ever runs concurrently with a long Reader session, but
 * acceptable for this single-admin personal project for now. */
export async function pinSnapshot(aa: Aa, version: number): Promise<void> {
  const now = Date.now();
  await aa.execute(
    "INSERT INTO snapshots (snapshot_id, version, holder, opened_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), version, "browser", now, now],
  );
}

const SCAN_BATCH_SIZE = 500;

/** The "no bundle" fallback (docs/data_model.md §6.1): idx_pv_live is
 * exactly `WHERE version_deleted IS NULL`, which -- since we always pin the
 * current head_version, never an older version -- already is "live at the
 * pinned version": nothing can have version_created beyond head_version. */
export async function scanLivePages(aa: Aa): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  let lastPageNo = -1;
  for (;;) {
    const rows = await aa.query(
      "SELECT page_no, version_created FROM page_versions WHERE version_deleted IS NULL AND page_no > ? ORDER BY page_no LIMIT ?",
      [lastPageNo, SCAN_BATCH_SIZE],
    );
    if (rows.length === 0) break;
    for (const [pageNo, versionCreated] of rows as [number, number][]) map.set(pageNo, versionCreated);
    lastPageNo = rows[rows.length - 1][0] as number;
    if (rows.length < SCAN_BATCH_SIZE) break;
  }
  return map;
}

/** The delta since a bundle's own built_at_version (docs/data_model.md
 * §6.1): newer/updated pages to ADD or overwrite in the bundle's page map,
 * plus page numbers to REMOVE because they were deleted (truncated) since
 * without ever getting a newer version. null in the returned map means
 * "remove"; a number means "set to this version_created". */
export async function fetchBundleDelta(aa: Aa, builtAtVersion: number, pinnedVersion: number): Promise<Map<number, number | null>> {
  const delta = new Map<number, number | null>();
  const added = await aa.query(
    "SELECT page_no, version_created FROM page_versions WHERE version_created > ? AND version_created <= ? " +
      "AND (version_deleted IS NULL OR version_deleted > ?)",
    [builtAtVersion, pinnedVersion, pinnedVersion],
  );
  for (const [pageNo, versionCreated] of added as [number, number][]) delta.set(pageNo, versionCreated);
  const deleted = await aa.query("SELECT DISTINCT page_no FROM page_versions WHERE version_deleted > ? AND version_deleted <= ?", [
    builtAtVersion,
    pinnedVersion,
  ]);
  for (const [pageNo] of deleted as [number][]) if (!delta.has(pageNo)) delta.set(pageNo, null);
  return delta;
}

const PAGE_FETCH_BATCH_SIZE = 100;

function batchQuery(pairs: Array<[number, number]>): [string, number[]] {
  const clauses = pairs.map(() => "(page_no = ? AND version_created = ?)").join(" OR ");
  return [`SELECT page_no, data FROM page_versions WHERE ${clauses}`, pairs.flat()];
}

/** Fetches actual page bytes for exactly the given (page_no, version_created)
 * pairs -- each one already pinned to an exact version by the caller, so
 * this is a direct lookup, not the "as of version V" range query
 * docs/data_model.md shows for a single uncached page. */
export async function fetchPageBytes(aa: Aa, pairs: Array<[number, number]>): Promise<Map<number, Uint8Array>> {
  const result = new Map<number, Uint8Array>();
  for (let i = 0; i < pairs.length; i += PAGE_FETCH_BATCH_SIZE) {
    const [sql, args] = batchQuery(pairs.slice(i, i + PAGE_FETCH_BATCH_SIZE));
    const rows = await aa.query(sql, args);
    for (const [pageNo, data] of rows as [number, Uint8Array][]) result.set(pageNo, data);
  }
  return result;
}
