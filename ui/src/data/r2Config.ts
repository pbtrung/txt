// R2 connection info, parsed from this account's own unwrapped credStore
// row's content (session.ts's resolveSession), not a local credential file
// or an in-db table: this account's R2 config is part of the same
// InstantDB-stored, umk-wrapped credential bundle (docs/data_model.md's
// credStore entity).
//
// Deliberately narrower than txt/creds.ts's R2Config (the CLI's own mirror
// of this same JSON shape): every account gets actual R2 *reads* exclusively
// through worker/r2Creds.ts's short-lived, prefix-scoped temporary
// credentials (see tempR2Creds.ts and docs/r2_credentials.md), so this type
// never carries a static access key. A `user`-role self row's r2_config
// never has one to begin with. An admin's own self row's r2_config *does*
// carry real read_write_access_key_id/read_write_secret_access_key fields
// (the CLI writes and uses them for --ingest/--clean-bucket) -- session.ts
// parses those separately, via parseAdminR2WriteCreds below, into their own
// admin-only field rather than folding them into this type, so every other
// caller of R2Config keeps its "no keys in here" assumption intact.

import { requireObject, requireString } from "./jsonObject";

export interface R2Config {
  endpoint: string;
  region: string;
  bucket: string;
}

export function parseR2Config(json: unknown): R2Config {
  const data = requireObject(json, "r2_config must be a JSON object");
  return {
    endpoint: requireString(data, "endpoint"),
    region: requireString(data, "region"),
    bucket: requireString(data, "bucket"),
  };
}

/** The admin's own real, static read-write R2 credential, when present in
 * this row's r2_config -- used only to build a write-capable client for the
 * sharing flow (adminShares.ts's grantShare), never for a Worker-brokered
 * read. Returns null for a `user`-role row's r2_config, which never carries
 * these fields at all -- absence here is normal, not an error. */
export interface AdminR2WriteCreds {
  accessKeyId: string;
  secretAccessKey: string;
}

export function parseAdminR2WriteCreds(
  json: unknown,
): AdminR2WriteCreds | null {
  const data = requireObject(json, "r2_config must be a JSON object");
  if (
    typeof data.read_write_access_key_id !== "string" ||
    typeof data.read_write_secret_access_key !== "string"
  ) {
    return null;
  }
  return {
    accessKeyId: data.read_write_access_key_id,
    secretAccessKey: data.read_write_secret_access_key,
  };
}
