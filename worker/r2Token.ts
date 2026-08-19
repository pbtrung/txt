// Verifies a signed account ticket plus a short-lived P-521 proof over the
// decrypted user handle and requested storage paths. This endpoint does not
// authenticate with Firebase or read Turso (docs/auth.md §4.2).

import { base64url, SignJWT } from "jose";

import {
  R2_PROOF_REQUEST_ID_BYTES,
  R2_TICKET_PROOF_VERSION,
  R2_USER_HANDLE_BYTES,
  canonicalR2TicketProof,
  isStoragePath,
  requireP521Signature,
  storagePathBinding,
} from "../shared/r2Proof";
import { decodeBase64, encodeBase64, equalBytes } from "./base64";
import { checkRateLimit } from "./cache";
import type { R2Ticket } from "./r2Ticket";
import { verifyR2Ticket } from "./r2Ticket";

const TTL_SECONDS = 900;
const MAX_PROOF_LIFETIME_SECONDS = 60;
const MAX_TICKET_LENGTH = 8192;
const SIGN_ALGORITHM = "ECDSA-P521-SHA512";

type CredentialType = "db_path" | "db_prefix";

interface R2Credential {
  type: CredentialType;
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expiration: string;
}

interface Paths {
  objectPaths: string[];
  prefixPaths: string[];
}

interface ProofRequest {
  ticket: string;
  userHandle: Uint8Array;
  dbPath: string;
  dbPrefix: string;
  version: number;
  expiresAt: number;
  requestId: Uint8Array;
  signature: Uint8Array;
}

export async function handleR2Token(request: Request, env: Env): Promise<Response> {
  const proof = await readProofRequest(request);
  if (!proof) return new Response("malformed path or proof", { status: 400 });

  const ticket = await verifyR2Ticket(proof.ticket, env.R2_TICKET_SECRET);
  if (!ticket) return new Response("invalid or expired ticket", { status: 401 });
  if (!(await verifyProof(ticket, proof))) {
    return new Response("path or proof not authorized", { status: 403 });
  }
  if (!(await checkRateLimit(env.KEYS_CACHE, ticket.subject, "r2-token"))) {
    return new Response("rate limit exceeded", { status: 429 });
  }
  return mintResponse(env, proof);
}

async function mintResponse(env: Env, proof: ProofRequest): Promise<Response> {
  try {
    const credentials = await mintCredentials(env, proof);
    return Response.json({
      credentials,
      endpoint: env.R2_ENDPOINT,
      bucket: env.R2_BUCKET,
      region: env.R2_REGION,
    });
  } catch {
    return new Response("R2 signing unavailable", { status: 503 });
  }
}

function mintCredentials(env: Env, proof: ProofRequest): Promise<R2Credential[]> {
  return Promise.all([
    mintCredential(env, "db_path", "object-read-write", {
      objectPaths: [proof.dbPath],
      prefixPaths: [],
    }),
    mintCredential(env, "db_prefix", "object-read-only", {
      objectPaths: [],
      prefixPaths: [`${proof.dbPrefix}/`],
    }),
  ]);
}

async function readProofRequest(request: Request): Promise<ProofRequest | null> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return parseProofBody(body);
  } catch {
    return null;
  }
}

function parseProofBody(body: Record<string, unknown>): ProofRequest | null {
  if (!isStoragePathValue(body.db_path) || !isStoragePathValue(body.db_prefix)) {
    return null;
  }
  if (!isTicket(body.ticket) || !isRecord(body.proof)) return null;
  return parseProof(body, body.proof);
}

function parseProof(
  body: Record<string, unknown>,
  proof: Record<string, unknown>,
): ProofRequest | null {
  const scalars = parseProofScalars(proof);
  if (!scalars) return null;
  const userHandleValue = body.user_handle;
  if (typeof userHandleValue !== "string") return null;
  const userHandle = decodeBase64(userHandleValue);
  if (
    userHandle.byteLength !== R2_USER_HANDLE_BYTES ||
    encodeBase64(userHandle) !== userHandleValue
  ) {
    return null;
  }
  return {
    ticket: body.ticket as string,
    userHandle,
    dbPath: body.db_path as string,
    dbPrefix: body.db_prefix as string,
    ...scalars,
  };
}

function parseProofScalars(
  proof: Record<string, unknown>,
): Pick<ProofRequest, "version" | "expiresAt" | "requestId" | "signature"> | null {
  const version = proof.version;
  const expiresAt = proof.expires_at;
  if (!isProofVersion(version) || !isProofExpiry(expiresAt)) return null;
  if (typeof proof.request_id !== "string" || typeof proof.signature !== "string") {
    return null;
  }
  const requestId = decodeBase64(proof.request_id);
  const signature = decodeBase64(proof.signature);
  if (requestId.byteLength !== R2_PROOF_REQUEST_ID_BYTES) return null;
  requireP521Signature(signature);
  return { version, expiresAt, requestId, signature };
}

function isProofVersion(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 0xffffffff
  );
}

function isProofExpiry(value: unknown): value is number {
  if (!Number.isSafeInteger(value)) return false;
  const now = Math.floor(Date.now() / 1000);
  return (
    (value as number) > now && (value as number) <= now + MAX_PROOF_LIFETIME_SECONDS
  );
}

async function verifyProof(ticket: R2Ticket, proof: ProofRequest): Promise<boolean> {
  if (!validSigningMetadata(ticket, proof.version)) return false;
  try {
    if (!(await validBindings(ticket, proof))) return false;
    return verifySignature(ticket, proof);
  } catch {
    return false;
  }
}

function validSigningMetadata(ticket: R2Ticket, proofVersion: number): boolean {
  return (
    proofVersion === R2_TICKET_PROOF_VERSION &&
    ticket.signVersion === 1 &&
    ticket.signAlgorithm === SIGN_ALGORITHM
  );
}

async function validBindings(ticket: R2Ticket, proof: ProofRequest): Promise<boolean> {
  const handleHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(proof.userHandle)),
  );
  const pathBinding = await storagePathBinding(proof.dbPath, proof.dbPrefix);
  return (
    equalBytes(ticket.userHandleHash, handleHash) &&
    equalBytes(ticket.dbBindingHash, pathBinding)
  );
}

async function verifySignature(
  ticket: R2Ticket,
  proof: ProofRequest,
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    new Uint8Array(ticket.signPublicKey),
    { name: "ECDSA", namedCurve: "P-521" },
    false,
    ["verify"],
  );
  const canonical = await canonicalR2TicketProof({
    version: proof.version,
    ticket: proof.ticket,
    userHandle: proof.userHandle,
    expiresAt: proof.expiresAt,
    requestId: proof.requestId,
    dbPath: proof.dbPath,
    dbPrefix: proof.dbPrefix,
  });
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-512" },
    publicKey,
    new Uint8Array(proof.signature),
    new Uint8Array(canonical),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoragePathValue(value: unknown): value is string {
  return typeof value === "string" && isStoragePath(value);
}

function isTicket(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_TICKET_LENGTH
  );
}

async function mintCredential(
  env: Env,
  type: CredentialType,
  scope: string,
  paths: Paths,
): Promise<R2Credential> {
  const endpointUrl = new URL(env.R2_ENDPOINT);
  const accountId = endpointUrl.hostname.split(".")[0];
  const jwt = await signedCredential(env, accountId, endpointUrl.host, scope, paths);
  return {
    type,
    access_key_id: env.R2_READ_WRITE_ACCESS_KEY_ID,
    secret_access_key: await sha256Hex(jwt),
    session_token: base64url.encode(`jwt/${jwt}`),
    expiration: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
  };
}

function signedCredential(
  env: Env,
  accountId: string,
  audience: string,
  scope: string,
  paths: Paths,
): Promise<string> {
  return new SignJWT({ bucket: env.R2_BUCKET, scope, paths })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(accountId)
    .setIssuer(env.R2_READ_WRITE_ACCESS_KEY_ID)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(env.R2_READ_WRITE_SECRET_ACCESS_KEY));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
