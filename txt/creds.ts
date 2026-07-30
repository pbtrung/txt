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
  return creds as OutCreds;
}
