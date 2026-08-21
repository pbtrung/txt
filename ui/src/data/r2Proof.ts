const STORAGE_PATH_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{52}$/;
const TICKET_PROOF_DOMAIN = "txt:r2-ticket-proof";

export const R2_TICKET_PROOF_VERSION = 2;
export const R2_PROOF_REQUEST_ID_BYTES = 32;
export const R2_USER_HANDLE_BYTES = 32;
export const P521_COMPONENT_BYTES = 66;
export const P521_SIGNATURE_BYTES = P521_COMPONENT_BYTES * 2;

export interface R2TicketProofInput {
  version: number;
  ticket: string;
  userHandle: Uint8Array;
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

export async function canonicalR2TicketProof(
  input: R2TicketProofInput,
): Promise<Uint8Array> {
  requireProofFields(input.version, input.expiresAt, input.requestId);
  if (input.userHandle.byteLength !== R2_USER_HANDLE_BYTES) {
    throw new Error(`user handle must be ${R2_USER_HANDLE_BYTES} bytes`);
  }
  const ticketHash = await digest("SHA-256", utf8(input.ticket));
  const pathBinding = await storagePathBinding(input.dbPath, input.dbPrefix);
  return concatBytes(
    utf8(TICKET_PROOF_DOMAIN),
    new Uint8Array([0]),
    u32be(input.version),
    ticketHash,
    input.userHandle,
    u64be(input.expiresAt),
    input.requestId,
    pathBinding,
  );
}

function requireProofFields(
  version: number,
  expiresAt: number,
  requestId: Uint8Array,
): void {
  if (!Number.isSafeInteger(version) || version < 0 || version > 0xffffffff) {
    throw new Error("proof version must be an unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new Error("proof expiry must be a non-negative safe integer");
  }
  if (requestId.byteLength !== R2_PROOF_REQUEST_ID_BYTES) {
    throw new Error(`proof request id must be ${R2_PROOF_REQUEST_ID_BYTES} bytes`);
  }
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
