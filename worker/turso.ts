// docs/auth.md §5 step 3: mint a database token scoped to one Turso
// database, valid for 60 minutes. authorization=full-access grants read
// and write on that database and nothing else; the empty body grants no
// read_attach permission, so the token can't attach any other database.

const PLATFORM_API_BASE = "https://api.turso.tech/v1";

export class DatabaseNotFoundError extends Error {}

export async function mintDbToken(orgToken: string, org: string, dbPath: string): Promise<string> {
  const url =
    `${PLATFORM_API_BASE}/organizations/${org}/databases/${dbPath}` +
    `/auth/tokens?expiration=60m&authorization=full-access`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${orgToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (resp.status === 404) throw new DatabaseNotFoundError(dbPath);
  if (!resp.ok) throw new Error(`mint db token failed: ${resp.status}`);
  const { jwt } = (await resp.json()) as { jwt: string };
  return jwt;
}
