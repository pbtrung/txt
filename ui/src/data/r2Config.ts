// R2 connection info, mirrors txt/creds.py's R2Config dataclass -- except
// here it's parsed from the decrypted r2_config.config JSON blob (see
// owner.ts's fetchR2Config), not from a local credential file.
//
// This UI is always a non-admin, browser-side client (docs/credentials.md)
// -- there's no admin-role session it ever needs to support -- so it
// mirrors txt/creds.py's UserCreds validation, not AdminCreds: read_write
// keys must be *absent*. txt/creds.py raises ValueError if either is
// present, precisely so a leaked or misconfigured user-role r2_config can't
// carry R2 write access it isn't supposed to have; this doesn't even keep
// a field to hold them in, so a future admin.py change or manual DB edit
// that put write keys in a user's r2_config row can't have them loaded into
// this UI's in-memory session at all, let alone used by it.

export interface R2Config {
  endpoint: string;
  region: string;
  bucket: string;
  readOnlyAccessKeyId: string;
  readOnlySecretAccessKey: string;
}

function requireString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`r2_config.${field} is required`);
  }
  return value;
}

function hasField(data: Record<string, unknown>, field: string): boolean {
  const value = data[field];
  return typeof value === "string" && value.length > 0;
}

export function parseR2Config(json: unknown): R2Config {
  if (typeof json !== "object" || json === null) {
    throw new Error("r2_config must be a JSON object");
  }
  const data = json as Record<string, unknown>;
  if (hasField(data, "read_write_access_key_id") || hasField(data, "read_write_secret_access_key")) {
    throw new Error("r2_config must not include read_write keys -- this UI only ever acts as a non-admin user");
  }
  return {
    endpoint: requireString(data, "endpoint"),
    region: requireString(data, "region"),
    bucket: requireString(data, "bucket"),
    readOnlyAccessKeyId: requireString(data, "read_only_access_key_id"),
    readOnlySecretAccessKey: requireString(data, "read_only_secret_access_key"),
  };
}
