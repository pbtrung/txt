// Replaces the old username/password/Turso unlock flow entirely. The
// unlock file (see screens/Unlock/UnlockScreen.tsx) is now a small JSON
// bundle of everything needed to open this account's SQLCipher db directly
// -- no server round trip to resolve a password or look up R2 credentials
// first. Field names mirror txt/creds.ts's snake_case (this project's one
// convention for ops-authored credential JSON, e.g. out_creds.json) --
// parseCreds is the snake_case-JSON -> camelCase-object boundary, same
// pattern r2Config.ts's parseR2Config already uses for its nested object.

import { base64ToBytes } from "../crypto/bytes";
import { parseR2Config, type R2Config } from "./r2Config";

export interface Creds {
  rqliteUrl: string;
  apiKey: string;
  userRootKey: Uint8Array;
  r2Config: R2Config;
}

export class CredsError extends Error {}

function requireString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CredsError(`${field} is required`);
  }
  return value;
}

/** Parses the unlock file's JSON contents into validated Creds. */
export function parseCreds(json: unknown): Creds {
  if (typeof json !== "object" || json === null) {
    throw new CredsError("creds file must be a JSON object");
  }
  const data = json as Record<string, unknown>;

  const rqliteUrl = requireString(data, "rqlite_url");
  const apiKey = requireString(data, "api_key");

  let userRootKey: Uint8Array;
  try {
    userRootKey = base64ToBytes(requireString(data, "user_root_key"));
  } catch {
    throw new CredsError("user_root_key must be valid base64");
  }
  if (userRootKey.length < 256) {
    throw new CredsError("user_root_key too short");
  }

  let r2Config: R2Config;
  try {
    r2Config = parseR2Config(data.r2_config);
  } catch (err) {
    throw new CredsError(err instanceof Error ? err.message : String(err));
  }

  return { rqliteUrl, apiKey, userRootKey, r2Config };
}

export async function loadCredsFromFile(file: File): Promise<Creds> {
  const text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CredsError("creds file is not valid JSON");
  }
  return parseCreds(json);
}
