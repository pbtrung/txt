// docs/auth.md §5 step 2: SELECT db_path, type FROM users WHERE id = ?
// against ctl, over the same libsql HTTP /v2/pipeline protocol
// txt/libsql_client.py uses server-side. ctl.users has no BLOB columns, so
// this only ever needs text args/cells -- no need to replicate that file's
// base64-blob or decimal-string-integer handling here.

export interface CtlUser {
  dbPath: string;
  type: "admin" | "user";
}

interface TextCell {
  value: string | null;
}

interface PipelineResponse {
  results: Array<{ response: { result: { rows: TextCell[][] } } }>;
}

export async function lookupUser(
  ctlDbUrl: string,
  ctlDbToken: string,
  uid: string,
): Promise<CtlUser | null> {
  const rows = await queryUsers(ctlDbUrl, ctlDbToken, uid);
  if (rows.length === 0) return null;
  const [dbPath, type] = rows[0];
  return { dbPath, type: type as "admin" | "user" };
}

async function queryUsers(
  ctlDbUrl: string,
  ctlDbToken: string,
  uid: string,
): Promise<string[][]> {
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
