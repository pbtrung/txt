// docs/auth.md §5 step 2: SELECT db_path, type FROM users WHERE id = ?
// against ctl, over the same libsql HTTP /v2/pipeline protocol
// txt/libsql_client.py uses server-side. `type` was dropped from this query
// early on (this Worker used to mint a token for whatever database a uid
// owns regardless of admin/user type), but r2Token.ts now needs it to
// decide bucket-wide read-write vs prefix-scoped read-only. ctl.users has
// no BLOB columns, so no need to replicate that Python client's base64-blob
// or decimal-string-integer cell handling here.

interface TextCell {
  value: string | null;
}

interface PipelineResponse {
  results: Array<{ response: { result: { rows: TextCell[][] } } }>;
}

export type AccountType = "admin" | "user";

export interface Account {
  dbPath: string;
  type: AccountType;
}

export async function lookupUser(ctlDbUrl: string, ctlDbToken: string, uid: string): Promise<Account | null> {
  const rows = await queryUsers(ctlDbUrl, ctlDbToken, uid);
  return rows.length === 0 ? null : { dbPath: rows[0][0], type: rows[0][1] as AccountType };
}

async function queryUsers(ctlDbUrl: string, ctlDbToken: string, uid: string): Promise<string[][]> {
  const base = ctlDbUrl.replace("libsql://", "https://");
  const body = {
    requests: [
      {
        type: "execute",
        stmt: { sql: "SELECT db_path, type FROM users WHERE id = ?", args: [{ type: "text", value: uid }] },
      },
      { type: "close" },
    ],
  };
  const resp = await fetch(`${base}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctlDbToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`ctl query failed: ${resp.status}`);
  const data = (await resp.json()) as PipelineResponse;
  return data.results[0].response.result.rows.map((row) => row.map((cell) => cell.value ?? ""));
}
