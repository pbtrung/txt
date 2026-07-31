// Minimal HTTP client for the real, deployed OpenResty+rqlite endpoint --
// see docker/auth_perms.lua and docker/README.md's "Request envelope" for
// the {statementId, batch} shape this speaks. Every call is a real network
// round trip (no local file access at all), unlike the rest of txt/ which
// talks to rqlite_txt.db directly via the WASM SQLite driver.

export interface RqliteResult {
  columns?: string[];
  values?: unknown[][];
  error?: string;
}

export interface RoundtripStat {
  label: string;
  ms: number;
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
