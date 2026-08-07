// Shared creds.json loading/validation helpers -- R2 config parsing plus
// generic field/key-length checks reused by every other creds.json loader
// in this directory (initAdminCreds.ts, scanCreds.ts).

export interface R2ConfigResolved {
  endpoint: string;
  region: string;
  bucket: string;
  readOnlyAccessKeyId: string;
  readOnlySecretAccessKey: string;
  readWriteAccessKeyId: string | null;
  readWriteSecretAccessKey: string | null;
}

// Generic, reused by every creds.json loader in this directory
// (initAdminCreds.ts, scanCreds.ts).
export function requireField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`creds.json missing/empty field: ${field}`);
  }
  return value;
}

export function checkKeyLength(
  buf: Buffer,
  minLen: number,
  field: string,
): void {
  if (buf.length < minLen) {
    throw new Error(`${field} too short (${buf.length} < ${minLen} bytes)`);
  }
}

export function loadR2Config(raw: any): R2ConfigResolved {
  const r2 = raw.r2_config ?? {};
  return {
    endpoint: requireField(r2.endpoint, "r2_config.endpoint"),
    region: requireField(r2.region, "r2_config.region"),
    bucket: requireField(r2.bucket, "r2_config.bucket"),
    readOnlyAccessKeyId: requireField(
      r2.read_only_access_key_id,
      "r2_config.read_only_access_key_id",
    ),
    readOnlySecretAccessKey: requireField(
      r2.read_only_secret_access_key,
      "r2_config.read_only_secret_access_key",
    ),
    readWriteAccessKeyId: r2.read_write_access_key_id || null,
    readWriteSecretAccessKey: r2.read_write_secret_access_key || null,
  };
}

export function hasReadWriteR2Config(r2: R2ConfigResolved): boolean {
  return Boolean(r2.readWriteAccessKeyId && r2.readWriteSecretAccessKey);
}

export function loadReadWriteR2Config(raw: any): R2ConfigResolved {
  const r2 = loadR2Config(raw);
  if (!hasReadWriteR2Config(r2)) {
    throw new Error(
      "r2_config missing read_write_access_key_id/read_write_secret_access_key",
    );
  }
  return r2;
}
