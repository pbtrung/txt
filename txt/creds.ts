// Loading/validating creds.json for --migrate --from-creds, identifying one
// account in a legacy sqlite snapshot. This shape is smaller than the
// browser/admin provisioning JSON: it needs the source username, wrapping
// keys, and R2 config, but not Firebase fields.
import { readFileSync } from "node:fs";
import * as C from "./constants.ts";

export interface R2ConfigResolved {
  endpoint: string;
  region: string;
  bucket: string;
  readOnlyAccessKeyId: string;
  readOnlySecretAccessKey: string;
  readWriteAccessKeyId: string | null;
  readWriteSecretAccessKey: string | null;
}

export interface Creds {
  username: string;
  usernameLookupKey: Buffer;
  userRootKey: Buffer;
  r2Config: R2ConfigResolved;
}

// Exported for reuse by other creds.json loaders (e.g. initAdminCreds.ts) --
// generic, not coupled to this file's own Creds shape.
export function requireField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`creds.json missing/empty field: ${field}`);
  }
  return value;
}

export function checkKeyLength(
  buf: Buffer,
  minLen: number,
  field: string,
): void {
  if (buf.length < minLen) {
    throw new Error(`${field} too short (${buf.length} < ${minLen} bytes)`);
  }
}

export function loadR2Config(raw: any): R2ConfigResolved {
  const r2 = raw.r2_config ?? {};
  return {
    endpoint: requireField(r2.endpoint, "r2_config.endpoint"),
    region: requireField(r2.region, "r2_config.region"),
    bucket: requireField(r2.bucket, "r2_config.bucket"),
    readOnlyAccessKeyId: requireField(
      r2.read_only_access_key_id,
      "r2_config.read_only_access_key_id",
    ),
    readOnlySecretAccessKey: requireField(
      r2.read_only_secret_access_key,
      "r2_config.read_only_secret_access_key",
    ),
    readWriteAccessKeyId: r2.read_write_access_key_id || null,
    readWriteSecretAccessKey: r2.read_write_secret_access_key || null,
  };
}

export function hasReadWriteR2Config(r2: R2ConfigResolved): boolean {
  return Boolean(r2.readWriteAccessKeyId && r2.readWriteSecretAccessKey);
}

export function loadReadWriteR2Config(raw: any): R2ConfigResolved {
  const r2 = loadR2Config(raw);
  if (!hasReadWriteR2Config(r2)) {
    throw new Error(
      "r2_config missing read_write_access_key_id/read_write_secret_access_key",
    );
  }
  return r2;
}

// Deletion needs read-write R2 keys; --dry-run only lists, so read-only-only
// creds are tolerated there (confirmed with the user -- a deliberate
// deviation from the Python reference, which always requires read-write).
function checkWriteAccess(r2: R2ConfigResolved, dryRun: boolean): void {
  if (dryRun) return;
  if (!hasReadWriteR2Config(r2)) {
    throw new Error(
      "r2_config must include read_write_access_key_id/read_write_secret_access_key for a live (non---dry-run) run",
    );
  }
}

export function loadCreds(path: string, dryRun: boolean): Creds {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const username = requireField(raw.username, "username");
  const usernameLookupKey = Buffer.from(
    requireField(raw.username_lookup_key, "username_lookup_key"),
    "base64",
  );
  const userRootKey = Buffer.from(
    requireField(raw.user_root_key, "user_root_key"),
    "base64",
  );
  checkKeyLength(
    usernameLookupKey,
    C.USERNAME_LOOKUP_KEY_MIN_LEN,
    "username_lookup_key",
  );
  checkKeyLength(userRootKey, C.USER_ROOT_KEY_MIN_LEN, "user_root_key");
  // password is part of the shared creds shape but unused here: this tool
  // goes straight from user_root_key to umk, no login/auth step.

  const r2Config = loadR2Config(raw);
  checkWriteAccess(r2Config, dryRun);
  return { username, usernameLookupKey, userRootKey, r2Config };
}
