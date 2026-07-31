// R2 connection info, mirrors txt/creds.ts's R2Config interface -- except
// here it's parsed from this account's own r2_config table row (one row
// per SQLCipher db, docs/data_model.md), fetched via dbWorker.ts's
// fetchR2Config, not from a local credential file.
//
// Every account's row holds a full read-only pair. read_write_access_key_id/
// read_write_secret_access_key are only populated for the admin account --
// the one whose row txt.ts --update-db writes with both pairs -- and NULL
// for every regular user's own database, so they're optional here rather
// than required.

export interface R2Config {
  endpoint: string;
  region: string;
  bucket: string;
  readOnlyAccessKeyId: string;
  readOnlySecretAccessKey: string;
  readWriteAccessKeyId?: string;
  readWriteSecretAccessKey?: string;
}

function requireString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`r2_config.${field} is required`);
  }
  return value;
}

function optionalString(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseR2Config(json: unknown): R2Config {
  if (typeof json !== "object" || json === null) {
    throw new Error("r2_config must be a JSON object");
  }
  const data = json as Record<string, unknown>;
  return {
    endpoint: requireString(data, "endpoint"),
    region: requireString(data, "region"),
    bucket: requireString(data, "bucket"),
    readOnlyAccessKeyId: requireString(data, "read_only_access_key_id"),
    readOnlySecretAccessKey: requireString(data, "read_only_secret_access_key"),
    readWriteAccessKeyId: optionalString(data, "read_write_access_key_id"),
    readWriteSecretAccessKey: optionalString(data, "read_write_secret_access_key"),
  };
}
