// docs/auth.md §4.2 / docs/crypto.md §"Owner-proof signatures": the
// canonical proof bytes and their P-521 verification. This module is pure
// crypto.subtle logic with no environment-specific dependency (unlike the
// Blob Format, docs/milestones.md Milestone 2's lesson) -- both the
// browser (signing, once the UI is wired up in a later milestone) and the
// Worker (verifying, here) can use the exact same canonical-bytes
// construction, and should, rather than risk two independently-written
// implementations drifting apart.
import type { TicketClaims } from "./ownerTicket";
import { base64Decode, base64UrlDecode, base64UrlEncode } from "./base64";

export interface ProofEnvelope {
  version: 1;
  expires_at: number;
  request_id: string; // base64 (standard, not url) 32 random bytes
  signature: string; // base64 (standard) raw P-521 signature, 132 bytes
}

const DOMAIN_LABEL = new TextEncoder().encode("txt:owner-proof:v1");
const MAX_PROOF_TTL_SECONDS = 60;
const SIGNATURE_LEN = 132;
const REQUEST_ID_LEN = 32;
const USER_HANDLE_LEN = 32;

export class ProofVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofVerificationError";
  }
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
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export interface CanonicalProofInput {
  exactCompactTicket: string;
  userHandle: Uint8Array; // 32 bytes
  expiresAt: number;
  requestId: Uint8Array; // 32 bytes
  dbPrefix: string;
  method: string;
  path: string;
  body: Uint8Array;
}

/** Builds the exact canonical bytes docs/crypto.md specifies, byte for
 * byte. Exported so a future client-side signer and this Worker-side
 * verifier are guaranteed to agree, rather than each re-deriving the spec
 * independently. */
export async function buildCanonicalProofBytes(
  input: CanonicalProofInput,
): Promise<Uint8Array> {
  const ticketHash = await sha256(new TextEncoder().encode(input.exactCompactTicket));
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

export interface VerifyProofInput {
  ticketClaims: TicketClaims; // already ticket-signature- and expiry-verified
  exactCompactTicket: string;
  proof: ProofEnvelope;
  userHandle: Uint8Array; // 32 bytes, from the request body
  dbPrefix: string; // from the request body
  method: string;
  path: string;
  body: Uint8Array; // exact raw request body bytes
  now?: number;
}

/** Verifies a proof envelope against the request it was presented with,
 * per docs/auth.md §4.2: proof freshness, the user_handle/db_prefix
 * binding to the ticket's own hashes, and the P-521 signature over the
 * exact canonical bytes for this exact request. Throws
 * `ProofVerificationError` on any failure. */
export async function verifyProof(input: VerifyProofInput): Promise<void> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const { proof } = input;

  if (proof.version !== 1) {
    throw new ProofVerificationError(
      `unsupported proof version: ${String(proof.version)}`,
    );
  }
  if (typeof proof.expires_at !== "number" || proof.expires_at <= now) {
    throw new ProofVerificationError("proof expired");
  }
  if (proof.expires_at - now > MAX_PROOF_TTL_SECONDS) {
    throw new ProofVerificationError("proof expiry too far in the future");
  }

  const signatureBytes = base64Decode(proof.signature);
  if (signatureBytes.length !== SIGNATURE_LEN) {
    throw new ProofVerificationError(
      `signature must be exactly ${SIGNATURE_LEN} bytes, got ${signatureBytes.length}`,
    );
  }
  const requestIdBytes = base64Decode(proof.request_id);
  if (requestIdBytes.length !== REQUEST_ID_LEN) {
    throw new ProofVerificationError(
      `request_id must be exactly ${REQUEST_ID_LEN} bytes, got ${requestIdBytes.length}`,
    );
  }
  if (input.userHandle.length !== USER_HANDLE_LEN) {
    throw new ProofVerificationError(
      `user_handle must be exactly ${USER_HANDLE_LEN} bytes, got ${input.userHandle.length}`,
    );
  }

  const userHandleHash = base64UrlEncode(await sha256(input.userHandle));
  if (userHandleHash !== input.ticketClaims.user_handle_hash) {
    throw new ProofVerificationError(
      "user_handle does not match ticket's user_handle_hash",
    );
  }
  const dbPrefixHash = base64UrlEncode(
    await sha256(new TextEncoder().encode(input.dbPrefix)),
  );
  if (dbPrefixHash !== input.ticketClaims.db_binding_hash) {
    throw new ProofVerificationError(
      "db_prefix does not match ticket's db_binding_hash",
    );
  }

  const canonicalBytes = await buildCanonicalProofBytes({
    exactCompactTicket: input.exactCompactTicket,
    userHandle: input.userHandle,
    expiresAt: proof.expires_at,
    requestId: requestIdBytes,
    dbPrefix: input.dbPrefix,
    method: input.method,
    path: input.path,
    body: input.body,
  });

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "spki",
      base64UrlDecode(input.ticketClaims.sign_public_key),
      { name: "ECDSA", namedCurve: "P-521" },
      false,
      ["verify"],
    );
  } catch {
    throw new ProofVerificationError("failed to import sign_public_key");
  }

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-512" },
    publicKey,
    signatureBytes,
    canonicalBytes,
  );
  if (!valid) {
    throw new ProofVerificationError("proof signature verification failed");
  }
}
