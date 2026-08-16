// The browser client's own creds.json shape -- a strict subset of
// txt/creds.py's Creds. It never carries turso_org_token/turso_ctl_db_name/
// turso_ctl_db_url (those talk to ctl directly and are the administrator's
// own out-of-band secret, docs/auth.md §1) nor any R2 access key or
// connection detail -- worker/r2Token.ts mints a short-lived, scoped
// credential, and its response is the client's only source of R2
// endpoint/bucket/region too (docs/auth.md §4.2). No Worker URL either:
// wrangler.jsonc's assets block always serves this build from the same
// origin the Worker itself answers /v1/* on, so workerClient.ts's
// requests are relative and need nothing configured here.
export interface BrowserCreds {
  firebase_email: string;
  firebase_password: string;
  firebase_api_key: string;
  user_root_key: string;
}

const REQUIRED_FIELDS = [
  "firebase_email",
  "firebase_password",
  "firebase_api_key",
  "user_root_key",
] as const;

function credentialsRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("creds.json must contain an object");
  }
  return data as Record<string, unknown>;
}

export function parseBrowserCreds(data: unknown): BrowserCreds {
  const record = credentialsRecord(data);
  const missing = REQUIRED_FIELDS.filter(
    (field) => typeof record[field] !== "string" || record[field].trim() === "",
  );
  if (missing.length > 0)
    throw new Error(`creds.json is missing: ${missing.join(", ")}`);
  return Object.fromEntries(
    REQUIRED_FIELDS.map((field) => [field, record[field]]),
  ) as unknown as BrowserCreds;
}
