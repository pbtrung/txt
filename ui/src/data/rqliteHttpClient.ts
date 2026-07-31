// Browser port of txt/rqliteHttpClient.ts -- same {statementId, batch} HTTP
// envelope against docker/auth_perms.lua, using the browser's native fetch
// instead of Node's. See docs/data_model.md for the wire shape.

import { base64ToBytes } from "../crypto/bytes";

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
  ): Promise<boolean> {
    const body = {
      statementId: "COMMIT",
      commit: {
        pages: pages.map((p) => ({ page_no: p.pageNo, data: encodeBlobParam(p.data) })),
        old_version: oldVersion,
        new_version: newVersion,
        page_count: pageCount,
      },
    };
    const res = await fetch(`${this.baseUrl}/db/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`rqlite /db/execute COMMIT failed: HTTP ${res.status}`);
    const decoded = (await res.json()) as { results?: RqliteResult[] };
    const results = decoded.results;
    if (!results || results.length < 2) throw new Error("COMMIT: malformed rqlite response");
    const casUpdate = results[1]!;
    if (casUpdate.error) throw new Error(`COMMIT CAS update failed: ${casUpdate.error}`);
    return (casUpdate.rows_affected ?? 0) > 0;
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
 * -- NOT base64 -- see CLAUDE.md/docs/data_model.md's noted gap. Used when
 * sending page.data on COMMIT (remoteVfs.ts). */
export function encodeBlobParam(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}
