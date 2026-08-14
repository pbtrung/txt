// Calls this project's own Cloudflare Worker (worker/dbToken.ts, per
// docs/auth.md §4) to exchange a Firebase ID token for a short-lived Turso
// database token scoped to this account's own AA.
export interface DbToken {
  dbToken: string;
  dbUrl: string;
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
