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

export function rootKeyBytes(creds: { user_root_key: string }): Buffer {
  return Buffer.from(creds.user_root_key, "base64");
}

function readJson(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function loadInCreds(path: string): InCreds {
  const creds = readJson(path) as Partial<InCreds>;
  if (!creds.user_root_key) throw new Error(`${path}: missing user_root_key`);
  if (!creds.r2_config) throw new Error(`${path}: missing r2_config`);
  return creds as InCreds;
}

export function loadOutCreds(path: string): OutCreds {
  const creds = readJson(path) as Partial<OutCreds>;
  if (!creds.user_root_key) throw new Error(`${path}: missing user_root_key`);
  const len = rootKeyBytes(creds as OutCreds).length;
  if (len < 256) throw new Error(`${path}: user_root_key must be >=256 raw bytes, got ${len}`);
  if (!creds.api_key) throw new Error(`${path}: missing api_key`);
  const apiKeyLen = Buffer.from(creds.api_key, "base64").length;
  if (apiKeyLen < 32)
    throw new Error(`${path}: api_key must be >=32 raw bytes (base64), got ${apiKeyLen}`);
  return creds as OutCreds;
}
