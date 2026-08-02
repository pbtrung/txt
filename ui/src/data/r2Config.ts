// R2 connection info, mirrors txt/creds.ts's R2Config interface -- parsed
// from this account's own unwrapped $users.creds payload (session.ts's
// resolveSession), not a local credential file or an in-db table: this
// account's R2 config is part of the same InstantDB-stored, umk-wrapped
// bundle as path_key/db_key (docs/data_model.md's Key Hierarchy).
//
// This port targets the admin account's own session only (no temporary,
// prefix-scoped credentials for a regular user-role account yet -- see
// CLAUDE.md), so read_write_access_key_id/read_write_secret_access_key are
// always expected to be populated in practice; they stay optional here
// regardless, since a user-role account's own r2_config would carry only
// the read-only pair once that support exists.

import { optionalString, requireObject, requireString } from "./jsonObject";

export interface R2Config {
  endpoint: string;
  region: string;
  bucket: string;
  readOnlyAccessKeyId: string;
  readOnlySecretAccessKey: string;
  readWriteAccessKeyId?: string;
  readWriteSecretAccessKey?: string;
}

export function parseR2Config(json: unknown): R2Config {
  const data = requireObject(json, "r2_config must be a JSON object");
  return {
    endpoint: requireString(data, "endpoint"),
    region: requireString(data, "region"),
    bucket: requireString(data, "bucket"),
    readOnlyAccessKeyId: requireString(data, "read_only_access_key_id"),
    readOnlySecretAccessKey: requireString(data, "read_only_secret_access_key"),
    readWriteAccessKeyId: optionalString(data, "read_write_access_key_id"),
    readWriteSecretAccessKey: optionalString(
      data,
      "read_write_secret_access_key",
    ),
  };
}
