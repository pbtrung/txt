// The browser client's own creds.json shape -- a strict subset of
// txt/creds.py's Creds. It never carries turso_org_token/turso_ctl_db_url/
// turso_group: those mint database tokens for the whole organization and
// are the Worker's own secret (docs/auth.md §1), never a client's.
export interface R2Config {
  endpoint: string;
  read_only_access_key_id: string;
  read_only_secret_access_key: string;
  region: string;
  bucket: string;
}

export interface BrowserCreds {
  firebase_email: string;
  firebase_password: string;
  firebase_api_key: string;
  user_root_key: string;
  r2_config: R2Config;
}

const REQUIRED_FIELDS = ["firebase_email", "firebase_password", "firebase_api_key", "user_root_key", "r2_config"] as const;
const REQUIRED_R2_FIELDS = ["endpoint", "read_only_access_key_id", "read_only_secret_access_key", "region", "bucket"] as const;

function missingFields(data: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((f) => !data[f]);
}

export function parseBrowserCreds(data: Record<string, unknown>): BrowserCreds {
  const missing = missingFields(data, REQUIRED_FIELDS);
  if (missing.length > 0) throw new Error(`creds.json is missing: ${missing.join(", ")}`);
  const r2 = data.r2_config as Record<string, unknown>;
  const missingR2 = missingFields(r2, REQUIRED_R2_FIELDS);
  if (missingR2.length > 0) throw new Error(`creds.json's r2_config is missing: ${missingR2.join(", ")}`);
  return data as unknown as BrowserCreds;
}
