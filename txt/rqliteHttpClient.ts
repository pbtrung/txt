// Minimal HTTP client for the real, deployed OpenResty+rqlite endpoint --
// see docker/auth_perms.lua and docker/README.md's "Request envelope" for
// the {statementId, batch} shape this speaks. Every call is a real network
// round trip (no local file access at all), unlike the rest of txt/ which
// talks to rqlite_txt.db directly via the WASM SQLite driver.

import { hashApiKey } from "./rqliteDb.ts";

export interface RqliteResult {
  columns?: string[];
  values?: unknown[][];
  error?: string;
  rows_affected?: number;
}

export interface RoundtripStat {
  label: string;
  ms: number;
}

export interface CommitPage {
  pageNo: number;
  data: Uint8Array;
}

export interface Meta {
  currentVersion: number;
  pageCount: number;
  pageSize: number;
}

export class RqliteHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly roundtrips: RoundtripStat[] = [];

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  query(
    statementId: string,
    batch: unknown[],
    extra: Record<string, unknown> = {},
  ): Promise<RqliteResult[]> {
    return this.request("query", statementId, batch, extra);
  }

  execute(
    statementId: string,
    batch: unknown[],
    extra: Record<string, unknown> = {},
  ): Promise<RqliteResult[]> {
    return this.request("execute", statementId, batch, extra);
  }

  /** COMMIT: docker/auth_perms.lua's guarded-INSERT + CAS-UPDATE pair (see
   * docs/data_model.md's "commit pattern"). Returns false (no throw) if the
   * CAS lost -- another writer committed first -- so the caller can reopen
   * against the new version and retry rather than treating it as a hard
   * error. ?transaction: without it rqlite doesn't guarantee the two
   * statements execute as one atomic unit (see ui/'s rqliteHttpClient.ts
   * commit(), which this mirrors, for the fuller explanation). */
  async commit(
    pages: CommitPage[],
    oldVersion: number,
    newVersion: number,
    pageCount: number,
    targetDbId?: string,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      statementId: "COMMIT",
      commit: {
        pages: pages.map((p) => ({ page_no: p.pageNo, data: encodeBlobParam(p.data) })),
        old_version: oldVersion,
        new_version: newVersion,
        page_count: pageCount,
      },
    };
    if (targetDbId !== undefined) body.target_db_id = targetDbId;
    const res = await fetch(`${this.baseUrl}/db/execute?transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`rqlite /db/execute COMMIT failed: HTTP ${res.status}`);
    const decoded = (await res.json()) as { results?: RqliteResult[] };
    const results = decoded.results;
    if (!results || results.length === 0)
      throw new Error("COMMIT: malformed rqlite response (no results)");
    if (results.length < 2) throw this.shortResultsError(results);
    return this.checkCommitResults(results, pages.length);
  }

  /** With ?transaction, rqlite stops (and returns fewer results than
   * statements sent) the moment one statement in the batch errors -- the
   * guarded page INSERT is statement 1, so a short results array almost
   * always means it, not the CAS UPDATE, is what actually failed. Surfaces
   * that statement's own SQL error instead of a generic "malformed
   * response" that hides the real cause. */
  private shortResultsError(results: RqliteResult[]): Error {
    const insert = results[0];
    if (insert?.error) return new Error(`COMMIT page insert failed: ${insert.error}`);
    return new Error(
      `COMMIT: malformed rqlite response (expected 2 results, got ${results.length})`,
    );
  }

  /** Checks BOTH statements of the commit pattern -- not just the CAS
   * update. A prior version of this method only ever looked at results[1]
   * (the UPDATE), silently ignoring whether the guarded page INSERT
   * (results[0]) actually inserted anything: if it errored (e.g. a
   * PRIMARY KEY conflict from a stray duplicate row) or inserted fewer
   * rows than expected while the UPDATE still won its own CAS check,
   * db_meta.current_version would advance while the page content itself
   * silently never landed -- a real bug this exact gap let go undetected
   * (see docs/cli.md's --test-write). */
  private checkCommitResults(results: RqliteResult[], pageCount: number): boolean {
    const insert = results[0]!;
    const casUpdate = results[1]!;
    if (casUpdate.error) throw new Error(`COMMIT CAS update failed: ${casUpdate.error}`);
    const casWon = (casUpdate.rows_affected ?? 0) > 0;
    if (!casWon) return false;
    if (insert.error) throw new Error(`COMMIT page insert failed: ${insert.error}`);
    const inserted = insert.rows_affected ?? 0;
    if (inserted !== pageCount) {
      throw new Error(
        `COMMIT inserted ${inserted} page row(s), expected ${pageCount} -- ` +
          "CAS reported a win but the page insert didn't fully apply",
      );
    }
    return true;
  }

  private async request(
    endpoint: "query" | "execute",
    statementId: string,
    batch: unknown[],
    extra: Record<string, unknown>,
  ): Promise<RqliteResult[]> {
    const body = JSON.stringify({ statementId, batch, ...extra });
    const start = performance.now();
    const res = await fetch(`${this.baseUrl}/db/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body,
    });
    this.roundtrips.push({ label: statementId, ms: performance.now() - start });
    return this.parseResponse(endpoint, statementId, res);
  }

  private async parseResponse(
    endpoint: string,
    statementId: string,
    res: Response,
  ): Promise<RqliteResult[]> {
    if (!res.ok)
      throw new Error(`rqlite /db/${endpoint} ${statementId} failed: HTTP ${res.status}`);
    const decoded = (await res.json()) as { results?: RqliteResult[] };
    if (!decoded.results)
      throw new Error(`rqlite /db/${endpoint} ${statementId}: malformed response (no results)`);
    return decoded.results;
  }
}

/** The rows of one rqlite statement result, throwing if that statement itself failed. */
export function resultRows(results: RqliteResult[], index = 0): unknown[][] {
  const result = results[index];
  if (!result) throw new Error(`rqlite response missing result[${index}]`);
  if (result.error) throw new Error(`rqlite statement failed: ${result.error}`);
  return result.values ?? [];
}

/** rqlite encodes BLOB columns as base64 strings by default -- see rqlite's own API docs. */
export function decodeBlobColumn(value: unknown): Buffer {
  if (typeof value !== "string")
    throw new Error(`expected base64 blob string, got ${typeof value}`);
  return Buffer.from(value, "base64");
}

/** rqlite BLOB positional params must be hex x'...' or a numeric byte array
 * -- NOT base64, unlike the query-result encoding decodeBlobColumn above
 * decodes. Used when sending page.data on COMMIT. Hex, not the numeric
 * array form: ~2 chars/byte versus ~3.5-3.7 (decimal digits + commas),
 * shrinking every COMMIT body by roughly 44% -- directly what let
 * INCREMENTAL_VACUUM_PAGE_COUNT (commands.ts) stay small enough to fit
 * docker/nginx.conf's client_body_buffer_size/client_max_body_size. */
export function encodeBlobParam(bytes: Uint8Array): string {
  return `x'${Buffer.from(bytes).toString("hex")}'`;
}

/**
 * GET_META/READ_PAGE/COMMIT are ordinary user-level statements, forced to
 * the caller's own db_id -- unless the key resolves to role='admin', which
 * has no implicit self and needs target_db_id named explicitly (see
 * docker/auth_perms.lua). Rather than requiring the caller to already know
 * its own user_id, look it up the same way auth_perms.lua's own identity
 * resolution does: api_keys.key_hash -> users.user_id, via the admin-only
 * RAW_QUERY escape hatch. This only works for an admin key -- for a genuine
 * user-role key it fails the same way any bogus statementId would (RAW_QUERY
 * itself is admin-only), which is exactly how a plain user key is told apart
 * from an admin one here.
 */
export async function resolveTargetDbId(
  client: RqliteHttpClient,
  apiKey: string,
): Promise<string | undefined> {
  const batch = [
    { sql: "SELECT user_id FROM api_keys WHERE key_hash = ?", args: [hashApiKey(apiKey)] },
  ];
  try {
    const row = resultRows(await client.query("RAW_QUERY", batch))[0];
    return row ? String(row[0]) : undefined;
  } catch {
    return undefined; // not an admin key -- GET_META/READ_PAGE will force db_id server-side instead
  }
}

/** Read-only, not SELECT * -- needs_gc is server-internal bookkeeping a
 * caller opening its own db has no use for. */
export async function fetchMeta(
  client: RqliteHttpClient,
  targetDbId: string | undefined,
): Promise<Meta> {
  const extra = targetDbId !== undefined ? { target_db_id: targetDbId } : {};
  const row = resultRows(await client.query("GET_META", [{}], extra))[0];
  if (!row) throw new Error("GET_META returned no row -- has this account committed a db yet?");
  return { currentVersion: Number(row[0]), pageCount: Number(row[1]), pageSize: Number(row[2]) };
}
