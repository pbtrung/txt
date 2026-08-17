const STORAGE_PATH_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{52}$/;
const PROOF_DOMAIN = "txt:r2-token-proof";

export const R2_PROOF_VERSION = 1;
export const R2_PROOF_REQUEST_ID_BYTES = 32;
export const P521_COMPONENT_BYTES = 66;
export const P521_SIGNATURE_BYTES = P521_COMPONENT_BYTES * 2;

export interface R2ProofInput {
  version: number;
  uid: string;
  firebaseIdToken: string;
  expiresAt: number;
  requestId: Uint8Array;
  dbPath: string;
  dbPrefix: string;
}

export function isStoragePath(value: string): boolean {
  return STORAGE_PATH_PATTERN.test(value);
}

export function requireStoragePath(value: string, name: string): void {
  if (!isStoragePath(value)) {
    throw new Error(`${name} must be a 52-character lowercase Crockford token`);
  }
}

export async function storagePathBinding(
  dbPath: string,
  dbPrefix: string,
): Promise<Uint8Array> {
  requireStoragePath(dbPath, "db_path");
  requireStoragePath(dbPrefix, "db_prefix");
  return digest("SHA-512", concatBytes(utf8(dbPath), utf8(dbPrefix)));
}

export async function canonicalR2Proof(input: R2ProofInput): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(input.version) ||
    input.version < 0 ||
    input.version > 0xffffffff
  ) {
    throw new Error("proof version must be an unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
    throw new Error("proof expiry must be a non-negative safe integer");
  }
  if (input.requestId.byteLength !== R2_PROOF_REQUEST_ID_BYTES) {
    throw new Error(`proof request id must be ${R2_PROOF_REQUEST_ID_BYTES} bytes`);
  }

  const uid = utf8(input.uid);
  if (uid.byteLength > 0xffffffff) throw new Error("uid is too long");

  const tokenHash = await digest("SHA-256", utf8(input.firebaseIdToken));
  const pathBinding = await storagePathBinding(input.dbPath, input.dbPrefix);

  return concatBytes(
    utf8(PROOF_DOMAIN),
    new Uint8Array([0]),
    u32be(input.version),
    u32be(uid.byteLength),
    uid,
    tokenHash,
    u64be(input.expiresAt),
    input.requestId,
    pathBinding,
  );
}

export function requireP521Signature(signature: Uint8Array): void {
  if (signature.byteLength !== P521_SIGNATURE_BYTES) {
    throw new Error(`P-521 signature must be exactly ${P521_SIGNATURE_BYTES} bytes`);
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64be(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function digest(
  algorithm: "SHA-256" | "SHA-512",
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const input = new Uint8Array(bytes);
  return new Uint8Array(await crypto.subtle.digest(algorithm, input));
}
