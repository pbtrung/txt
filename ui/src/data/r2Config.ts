// R2 connection info, parsed from this account's own unwrapped credStore
// row's content (session.ts's resolveSession), not a local credential file
// or an in-db table: this account's R2 config is part of the same
// InstantDB-stored, umk-wrapped credential bundle (docs/data_model.md's
// credStore entity).
//
// Deliberately narrower than txt/creds.ts's R2Config (the CLI's own mirror
// of this same JSON shape): browser session state never retains a static R2
// access key, and every account gets actual R2 access exclusively through
// worker/r2Creds.ts's short-lived, prefix-scoped temporary credentials (see
// tempR2Creds.ts and docs/r2_credentials.md).
// The stored r2_config JSON may still carry read_only_access_key_id/
// read_write_access_key_id/etc. (the CLI still writes them, for its own
// Node-side use). Admin unlock decrypts that combined JSON payload before
// this parser runs, but this parser discards the access-key fields.

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
