// docs/auth.md §4.2 / docs/crypto.md "Owner-proof signatures": builds and
// signs the exact canonical bytes the Worker (worker/ownerProof.ts)
// verifies independently, so the two sides are guaranteed to agree rather
// than risk two independently-written implementations drifting apart.
import { toBase64 } from "../util/base64";

const PROOF_VERSION = 1;
export const P521_SIGNATURE_BYTES = 132;
const DOMAIN_LABEL = new TextEncoder().encode("txt:owner-proof:v1");
const PROOF_TTL_SECONDS = 45; // comfortably under docs/auth.md §4.2's 60-second cap
const REQUEST_ID_BYTES = 32;

export interface ProofEnvelope {
  version: 1;
  expires_at: number;
  request_id: string; // base64, 32 random bytes
  signature: string; // base64, raw P-521 signature, 132 bytes
}

export interface OwnerSigningIdentity {
  ticket: string;
  userHandle: Uint8Array; // 32 bytes
  privateKey: CryptoKey;
}

interface SignedProofRequest {
  envelope: ProofEnvelope;
  body: Uint8Array;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u64be(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(value), false);
  return new Uint8Array(buf);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

export interface CanonicalProofInput {
  ticket: string;
  userHandle: Uint8Array;
  expiresAt: number;
  requestId: Uint8Array;
  dbPrefix: string;
  method: string;
  path: string;
  body: Uint8Array;
}

/** The exact canonical bytes docs/crypto.md specifies, byte for byte --
 * mirrors worker/ownerProof.ts's buildCanonicalProofBytes(). */
export async function buildCanonicalProofBytes(
  input: CanonicalProofInput,
): Promise<Uint8Array> {
  const ticketHash = await sha256(new TextEncoder().encode(input.ticket));
  const dbPrefixHash = await sha256(new TextEncoder().encode(input.dbPrefix));
  const methodPathBodyHash = await sha256(
    concat(
      new TextEncoder().encode(input.method),
      new Uint8Array([0]),
      new TextEncoder().encode(input.path),
      new Uint8Array([0]),
      input.body,
    ),
  );
  return concat(
    DOMAIN_LABEL,
    new Uint8Array([0]),
    ticketHash,
    input.userHandle,
    u64be(input.expiresAt),
    input.requestId,
    dbPrefixHash,
    methodPathBodyHash,
  );
}

/** Signs a fresh proof for one request, and returns the exact raw body
 * bytes the proof signed over so the caller sends precisely those bytes --
 * never a re-serialization, which could reorder keys or change whitespace
 * and silently break the signature (docs/auth.md §4.2). */
export async function signOwnerProof(
  signing: OwnerSigningIdentity,
  dbPrefix: string,
  method: string,
  path: string,
  bodyFields: Record<string, unknown>,
): Promise<SignedProofRequest> {
  const expiresAt = Math.floor(Date.now() / 1000) + PROOF_TTL_SECONDS;
  const requestId = crypto.getRandomValues(new Uint8Array(REQUEST_ID_BYTES));
  const body = new TextEncoder().encode(
    JSON.stringify({
      ...bodyFields,
      user_handle: toBase64(signing.userHandle),
      db_prefix: dbPrefix,
    }),
  );
  const canonical = await buildCanonicalProofBytes({
    ticket: signing.ticket,
    userHandle: signing.userHandle,
    expiresAt,
    requestId,
    dbPrefix,
    method,
    path,
    body,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-512" },
      signing.privateKey,
      new Uint8Array(canonical),
    ),
  );
  if (signature.byteLength !== P521_SIGNATURE_BYTES) {
    throw new Error(`P-521 signature must be exactly ${P521_SIGNATURE_BYTES} bytes`);
  }
  return {
    envelope: {
      version: PROOF_VERSION,
      expires_at: expiresAt,
      request_id: toBase64(requestId),
      signature: toBase64(signature),
    },
    body,
  };
}
