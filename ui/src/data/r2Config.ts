// R2 connection info, mirrors txt/creds.py's R2Config dataclass -- except
// here it's parsed from the decrypted r2_config.config JSON blob (see
// owner.ts's fetchR2Config), not from a local credential file.

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
