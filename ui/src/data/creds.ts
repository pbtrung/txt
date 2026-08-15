// The browser client's own creds.json shape -- a strict subset of
// txt/creds.py's Creds. It never carries turso_org_token/turso_ctl_db_name/
// turso_ctl_db_url (those talk to ctl directly and are the administrator's
// own out-of-band secret, docs/auth.md §1) nor any R2 access key or
// connection detail -- worker/r2Token.ts mints a short-lived, scoped
// credential, and its response is the client's only source of R2
// endpoint/bucket/region too (docs/auth.md §4.2). The Worker's own URL is
// read from this file too, rather than baked in at build time, so the same
// build can be pointed at any deployment.
export interface BrowserCreds {
  firebase_email: string;
  firebase_password: string;
  firebase_api_key: string;
  user_root_key: string;
  cf_worker_url: string;
}

const REQUIRED_FIELDS = [
  "firebase_email",
  "firebase_password",
  "firebase_api_key",
  "user_root_key",
  "cf_worker_url",
] as const;

function missingFields(
  data: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter((f) => !data[f]);
}

export function parseBrowserCreds(data: Record<string, unknown>): BrowserCreds {
  const missing = missingFields(data, REQUIRED_FIELDS);
  if (missing.length > 0)
    throw new Error(`creds.json is missing: ${missing.join(", ")}`);
  return data as unknown as BrowserCreds;
}
