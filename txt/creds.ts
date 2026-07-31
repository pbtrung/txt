import fs from "node:fs";

export interface R2Config {
  endpoint: string;
  read_only_access_key_id: string;
  read_only_secret_access_key: string;
  read_write_access_key_id: string;
  read_write_secret_access_key: string;
  region: string;
  bucket: string;
}

export interface InCreds {
  user_root_key: string;
  r2_config: R2Config;
}

export interface OutCreds {
  user_root_key: string;
  /** Bearer token for the seeded admin account, base64 -- hashed as-is into api_keys.key_hash. */
  api_key: string;
}

export interface PerfCreds {
  /** Base URL of a live OpenResty+rqlite deployment, e.g. "https://host:4001". */
  rqlite_url: string;
  /**
   * Bearer token, base64 -- the caller's own api_key. If this resolves to
   * role='admin', TestPerfCommand looks up that account's own user_id itself
   * (api_keys.key_hash -> users.user_id, via RAW_QUERY) rather than needing
   * it supplied here -- auth_perms.lua gives admin no implicit self, so
   * acting on any tenant (including the admin's own account) needs an
   * explicit target_db_id, but there's no reason the caller has to already
   * know its own user_id to provide one.
   */
  api_key: string;
  user_root_key: string;
}

export function rootKeyBytes(creds: { user_root_key: string }): Buffer {
  return Buffer.from(creds.user_root_key, "base64");
}

function readJson(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

/** Throws `${path}: missing ${String(key)}` unless creds[key] is present -- every loader's first check. */
function requireField<T extends object, K extends keyof T>(
  path: string,
  creds: Partial<T>,
  key: K,
): void {
  if (!creds[key]) throw new Error(`${path}: missing ${String(key)}`);
}

/** Throws unless a base64 field decodes to at least minBytes raw bytes -- user_root_key/api_key's shared shape. */
function requireMinBytes(path: string, field: string, base64: string, minBytes: number): void {
  const len = Buffer.from(base64, "base64").length;
  if (len < minBytes)
    throw new Error(`${path}: ${field} must be >=${minBytes} raw bytes, got ${len}`);
}

export function loadInCreds(path: string): InCreds {
  const creds = readJson(path) as Partial<InCreds>;
  requireField(path, creds, "user_root_key");
  requireField(path, creds, "r2_config");
  return creds as InCreds;
}

export function loadOutCreds(path: string): OutCreds {
  const creds = readJson(path) as Partial<OutCreds>;
  requireField(path, creds, "user_root_key");
  requireMinBytes(path, "user_root_key", creds.user_root_key!, 256);
  requireField(path, creds, "api_key");
  requireMinBytes(path, "api_key", creds.api_key!, 32);
  return creds as OutCreds;
}

export function loadPerfCreds(path: string): PerfCreds {
  const creds = readJson(path) as Partial<PerfCreds>;
  requireField(path, creds, "rqlite_url");
  requireField(path, creds, "api_key");
  requireField(path, creds, "user_root_key");
  requireMinBytes(path, "user_root_key", creds.user_root_key!, 256);
  return creds as PerfCreds;
}
