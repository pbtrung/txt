// Replaces the old username/password/Turso unlock flow entirely. The
// unlock file (see screens/Unlock/UnlockScreen.tsx) is now a small JSON
// bundle of everything needed to open this account's SQLCipher db directly
// -- no server round trip to resolve a password first. Field names mirror
// txt/creds.ts's snake_case (this project's one convention for ops-authored
// credential JSON, e.g. out_creds.json) -- parseCreds is the
// snake_case-JSON -> camelCase-object boundary. No r2_config here (unlike
// txt/creds.ts's InCreds, which is a CLI operator's own file, not an end
// user's unlock file): this account's R2 credentials live in its own
// SQLCipher db (the r2_config table, docs/data_model.md) and are read from
// there via dbWorker.ts's fetchR2Config, not bundled into this file.

import { base64ToBytes } from "../crypto/bytes";

export interface Creds {
  rqliteUrl: string;
  apiKey: string;
  userRootKey: Uint8Array;
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

  return { rqliteUrl, apiKey, userRootKey };
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
