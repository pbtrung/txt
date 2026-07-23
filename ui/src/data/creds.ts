// Parses/validates the config JSON this UI is unlocked with. Mirrors
// txt/creds.py's Creds base class -- same fields and the same validation --
// except there is no r2_config field here: unlike admin_cred_template.json/
// user_cred_template.json, this UI's config carries no R2 keys at all.
// r2_config is fetched from Turso's r2_config table and decrypted with the
// account's umk instead (see src/data/owner.ts's fetchR2Config), per
// docs/data_model.md.

import { base64ToBytes } from "../crypto/bytes";
import { USERNAME_LOOKUP_KEY_MIN_LEN, USER_ROOT_KEY_MIN_LEN } from "../crypto/constants";

export interface Creds {
  tursoDatabaseUrl: string;
  tursoAuthToken: string;
  username: string;
  usernameLookupKey: Uint8Array;
  password: string;
  displayName: string;
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

/** Parses the config file's JSON contents into validated Creds. */
export function parseCreds(json: unknown): Creds {
  if (typeof json !== "object" || json === null) {
    throw new CredsError("config must be a JSON object");
  }
  const data = json as Record<string, unknown>;

  const tursoDatabaseUrl = requireString(data, "turso_database_url");
  const tursoAuthToken = requireString(data, "turso_auth_token");
  const username = requireString(data, "username");
  const password = requireString(data, "password");
  const displayName = requireString(data, "display_name");

  let usernameLookupKey: Uint8Array;
  let userRootKey: Uint8Array;
  try {
    usernameLookupKey = base64ToBytes(requireString(data, "username_lookup_key"));
    userRootKey = base64ToBytes(requireString(data, "user_root_key"));
  } catch {
    throw new CredsError("username_lookup_key/user_root_key must be valid base64");
  }

  if (usernameLookupKey.length < USERNAME_LOOKUP_KEY_MIN_LEN) {
    throw new CredsError("username_lookup_key too short");
  }
  if (userRootKey.length < USER_ROOT_KEY_MIN_LEN) {
    throw new CredsError("user_root_key too short");
  }

  return {
    tursoDatabaseUrl,
    tursoAuthToken,
    username,
    usernameLookupKey,
    password,
    displayName,
    userRootKey,
  };
}
