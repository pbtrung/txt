// Browser port of txt/rqliteHttpClient.ts -- same {statementId, batch} HTTP
// envelope against docker/auth_perms.lua, using the browser's native fetch
// instead of Node's. See docs/data_model.md for the wire shape.

import { sha3_256 } from "@noble/hashes/sha3.js";
import { base64ToBytes, bytesToBase64 } from "../crypto/bytes";

export interface RqliteResult {
  columns?: string[];
  values?: unknown[][];
  error?: string;
  rows_affected?: number;
}

export interface CommitPage {
  pageNo: number;
  data: Uint8Array;
}

export class RqliteHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

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
   * against the new version and retry rather than treating it as a hard error. */
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
    // ?transaction: rqlite only wraps a multi-statement /db/execute request
    // in one atomic transaction when explicitly asked -- without it, the
    // guarded INSERT and the CAS UPDATE (auth_perms.lua's
    // build_commit_statements) aren't guaranteed to execute as a single
    // all-or-nothing unit, which docs/data_model.md's "commit pattern"
    // section assumes they do. nginx.conf's `proxy_pass http://rqlite;`
    // (no URI segment) forwards the request's query string through
    // unchanged, so this reaches rqlite even though auth_perms.lua only
    // rewrites the body, not the URI.
    const res = await fetch(`${this.baseUrl}/db/execute?transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`rqlite /db/execute COMMIT failed: HTTP ${res.status}`);
    const decoded = (await res.json()) as { results?: RqliteResult[] };
    const results = decoded.results;
    if (!results || results.length === 0) {
      throw new Error("COMMIT: malformed rqlite response (no results)");
    }
    if (results.length < 2) throw shortResultsError(results);
    return checkCommitResults(results, pages.length);
  }

  private async request(
    endpoint: "query" | "execute",
    statementId: string,
    batch: unknown[],
    extra: Record<string, unknown>,
  ): Promise<RqliteResult[]> {
    const res = await fetch(`${this.baseUrl}/db/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ statementId, batch, ...extra }),
    });
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

/** Checks BOTH statements of the commit pattern -- not just the CAS update.
 * A prior version of commit() only ever looked at results[1] (the UPDATE),
 * silently ignoring whether the guarded page INSERT (results[0]) actually
 * inserted anything: if it errored (e.g. a PRIMARY KEY conflict from a
 * stray duplicate row) or inserted fewer rows than expected while the
 * UPDATE still won its own CAS check, db_meta.current_version would
 * advance while the page content itself silently never landed -- a real
 * bug this exact gap let go undetected. */
function checkCommitResults(results: RqliteResult[], pageCount: number): boolean {
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

/** With ?transaction, rqlite stops (and returns fewer results than
 * statements sent) the moment one statement in the batch errors -- the
 * guarded page INSERT is statement 1, so a short results array almost
 * always means it, not the CAS UPDATE, is what actually failed. Surfaces
 * that statement's own SQL error instead of a generic "malformed response"
 * that hides the real cause. */
function shortResultsError(results: RqliteResult[]): Error {
  const insert = results[0];
  if (insert?.error) return new Error(`COMMIT page insert failed: ${insert.error}`);
  return new Error(`COMMIT: malformed rqlite response (expected 2 results, got ${results.length})`);
}

/** The rows of one rqlite statement result, throwing if that statement itself failed. */
export function resultRows(results: RqliteResult[], index = 0): unknown[][] {
  const result = results[index];
  if (!result) throw new Error(`rqlite response missing result[${index}]`);
  if (result.error) throw new Error(`rqlite statement failed: ${result.error}`);
  return result.values ?? [];
}

/** rqlite encodes BLOB columns as base64 strings by default -- see rqlite's own API docs. */
export function decodeBlobColumn(value: unknown): Uint8Array {
  if (typeof value !== "string")
    throw new Error(`expected base64 blob string, got ${typeof value}`);
  return base64ToBytes(value);
}

/** rqlite BLOB positional params must be hex x'...' or a numeric byte array
 * -- NOT base64, unlike the query-result encoding decodeBlobColumn above
 * decodes. Used when sending page.data on COMMIT (remoteVfs.ts). Hex, not
 * the numeric array form: ~2 chars/byte versus ~3.5-3.7 (decimal digits +
 * commas), shrinking every COMMIT body by roughly 44%. */
export function encodeBlobParam(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `x'${hex}'`;
}

/** SHA3-256 of apiKey, base64-encoded -- matches docker/auth_perms.lua's own
 * key_hash lookup (see docs/data_model.md), so this can find the same
 * api_keys row server-side identity resolution would. Browser WebCrypto has
 * no SHA3 (only the unrelated SHA-2 family), hence @noble/hashes here. */
export function hashApiKey(apiKey: string): string {
  return bytesToBase64(sha3_256(new TextEncoder().encode(apiKey)));
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
 * from an admin one here. Mirrors txt/commands.ts's TestPerfCommand, which
 * hit this identical requirement first.
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
    return undefined; // not an admin key -- GET_META/READ_PAGE/COMMIT will force db_id server-side instead
  }
}
