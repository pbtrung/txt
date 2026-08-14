// A browser-side libsql/Turso HTTP /v2/pipeline client, mirroring
// txt/libsql_client.py's wire format exactly: BLOB args/cells as
// {"type":"blob","base64":...}, integer cells as decimal strings (Hrana's
// own way of preserving full 64-bit precision across JSON) -- see
// CLAUDE.md's documented Hrana quirks. worker/ctl.ts talks the same
// protocol but only ever needs text cells for ctl.users, so it doesn't
// replicate this blob/integer handling.
export type SqlArg = Uint8Array | number | string;
export type CellValue = Uint8Array | number | string | null;

interface Cell {
  type?: string;
  value?: string | null;
  base64?: string;
}
interface PipelineResult {
  response: { result: { rows: Cell[][] } };
}
interface PipelineResponse {
  results: PipelineResult[];
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function toArg(value: SqlArg): Record<string, unknown> {
  if (value instanceof Uint8Array) return { type: "blob", base64: toBase64(value) };
  if (typeof value === "number") return { type: "integer", value: String(value) };
  return { type: "text", value };
}

function cellValue(cell: Cell): CellValue {
  if (cell.type === "blob") return fromBase64(cell.base64 ?? "");
  if (cell.type === "integer") return Number(cell.value);
  return cell.value ?? null;
}

interface Stmt {
  sql: string;
  args: Record<string, unknown>[];
}

function buildStmt(sql: string, args: SqlArg[]): Stmt {
  return { sql, args: args.map(toArg) };
}

export class LibsqlClient {
  private readonly base: string;

  constructor(dbUrl: string, private readonly token: string) {
    this.base = dbUrl.replace("libsql://", "https://");
  }

  async execute(sql: string, args: SqlArg[] = []): Promise<void> {
    await this.pipeline([buildStmt(sql, args)]);
  }

  async query(sql: string, args: SqlArg[] = []): Promise<CellValue[][]> {
    const [result] = await this.pipeline([buildStmt(sql, args)]);
    return result.response.result.rows.map((row) => row.map(cellValue));
  }

  private async pipeline(stmts: Stmt[]): Promise<PipelineResult[]> {
    const body = { requests: [...stmts.map((stmt) => ({ type: "execute", stmt })), { type: "close" }] };
    const resp = await fetch(`${this.base}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`AA request failed: ${resp.status}`);
    const data = (await resp.json()) as PipelineResponse;
    return data.results;
  }
}
