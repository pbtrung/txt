// Calls this project's own Cloudflare Worker to exchange a Firebase ID
// token for short-lived credentials: a Turso database token scoped to this
// account's own AA (worker/dbToken.ts, docs/auth.md §4), or an R2 temp
// credential (worker/r2Token.ts) scoped read-only to this account's own
// db_prefix -- or, for the admin, bucket-wide read-write.
export interface DbToken {
  dbToken: string;
  dbUrl: string;
}

export interface R2TempCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAtMs: number;
}

export async function fetchDbToken(workerUrl: string, idToken: string): Promise<DbToken> {
  const resp = await fetch(`${workerUrl}/v1/db-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (resp.status === 403) throw new Error("account not provisioned yet -- ask the administrator to set it up");
  if (!resp.ok) throw new Error(`could not obtain a database token: ${resp.status}`);
  const data = (await resp.json()) as { db_token: string; db_url: string };
  return { dbToken: data.db_token, dbUrl: data.db_url };
}

export async function fetchR2Token(workerUrl: string, idToken: string, dbPrefix: string): Promise<R2TempCredential> {
  const resp = await fetch(`${workerUrl}/v1/r2-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ db_prefix: dbPrefix }),
  });
  if (!resp.ok) throw new Error(`could not obtain an R2 credential: ${resp.status}`);
  const data = (await resp.json()) as { access_key_id: string; secret_access_key: string; session_token: string; expires_at_ms: number };
  return { accessKeyId: data.access_key_id, secretAccessKey: data.secret_access_key, sessionToken: data.session_token, expiresAtMs: data.expires_at_ms };
}
