// Verifies a short-lived, per-user P-521 proof over the authenticated uid,
// exact Firebase bearer token, and requested storage paths before minting
// two least-privilege R2 credentials (docs/auth.md §4.2).

import { base64url, SignJWT } from "jose";

import {
  R2_PROOF_REQUEST_ID_BYTES,
  canonicalR2Proof,
  isStoragePath,
  requireP521Signature,
  storagePathBinding,
} from "../shared/r2Proof";
import type { AccountLookup } from "./account";
import { getAccount } from "./account";
import { verifiedIdentity } from "./auth";
import type { Account } from "./ctl";

const TTL_SECONDS = 900;
const MAX_PROOF_LIFETIME_SECONDS = 60;
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
  dbPath: string;
  dbPrefix: string;
  version: number;
  expiresAt: number;
  requestId: Uint8Array;
  signature: Uint8Array;
}

export async function handleR2Token(request: Request, env: Env): Promise<Response> {
  const identity = await verifiedIdentity(request, env.FIREBASE_PROJECT_ID);
  if (identity === null) {
    return new Response("missing or invalid bearer token", { status: 401 });
  }

  const result = await getAccount(env, identity.uid);
  if (result.status !== "ok") return statusResponse(result);

  const proof = await readProofRequest(request);
  if (!proof) return new Response("malformed path or proof", { status: 400 });

  if (!(await verifyProof(result.account, identity.uid, identity.idToken, proof))) {
    return new Response("path or proof not authorized", { status: 403 });
  }

  try {
    const credentials = await Promise.all([
      mintCredential(env, "db_path", "object-read-write", {
        objectPaths: [proof.dbPath],
        prefixPaths: [],
      }),
      mintCredential(env, "db_prefix", "object-read-only", {
        objectPaths: [],
        prefixPaths: [`${proof.dbPrefix}/`],
      }),
    ]);
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

function statusResponse(result: Exclude<AccountLookup, { status: "ok" }>): Response {
  if (result.status === "rate_limited") {
    return new Response("rate limit exceeded", { status: 429 });
  }
  if (result.status === "not_provisioned") {
    return new Response("not provisioned", { status: 403 });
  }
  return new Response("ctl unavailable", { status: 503 });
}

async function readProofRequest(request: Request): Promise<ProofRequest | null> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!isStoragePathValue(body.db_path) || !isStoragePathValue(body.db_prefix)) {
      return null;
    }
    if (!isRecord(body.proof)) return null;
    const version = body.proof.version;
    const expiresAt = body.proof.expires_at;
    const requestIdValue = body.proof.request_id;
    const signatureValue = body.proof.signature;
    if (
      !Number.isSafeInteger(version) ||
      (version as number) < 0 ||
      (version as number) > 0xffffffff
    ) {
      return null;
    }
    if (!Number.isSafeInteger(expiresAt)) return null;
    if (typeof requestIdValue !== "string" || typeof signatureValue !== "string") {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (
      (expiresAt as number) <= now ||
      (expiresAt as number) > now + MAX_PROOF_LIFETIME_SECONDS
    ) {
      return null;
    }
    const requestId = decodeBase64(requestIdValue);
    const signature = decodeBase64(signatureValue);
    if (requestId.byteLength !== R2_PROOF_REQUEST_ID_BYTES) return null;
    requireP521Signature(signature);
    return {
      dbPath: body.db_path,
      dbPrefix: body.db_prefix,
      version: version as number,
      expiresAt: expiresAt as number,
      requestId,
      signature,
    };
  } catch {
    return null;
  }
}

async function verifyProof(
  account: Account,
  uid: string,
  idToken: string,
  proof: ProofRequest,
): Promise<boolean> {
  if (
    proof.version !== account.signVersion ||
    account.signAlgorithm !== SIGN_ALGORITHM
  ) {
    return false;
  }

  try {
    const expectedBinding = decodeBase64(account.dbBindingHash);
    const actualBinding = await storagePathBinding(proof.dbPath, proof.dbPrefix);
    if (!equalBytes(expectedBinding, actualBinding)) return false;

    const publicKeyBytes = decodeBase64(account.signPublicKey);
    const publicKey = await crypto.subtle.importKey(
      "spki",
      new Uint8Array(publicKeyBytes),
      { name: "ECDSA", namedCurve: "P-521" },
      false,
      ["verify"],
    );
    const canonical = await canonicalR2Proof({
      version: proof.version,
      uid,
      firebaseIdToken: idToken,
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
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoragePathValue(value: unknown): value is string {
  return typeof value === "string" && isStoragePath(value);
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64");
  }
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function mintCredential(
  env: Env,
  type: CredentialType,
  scope: string,
  paths: Paths,
): Promise<R2Credential> {
  const endpointUrl = new URL(env.R2_ENDPOINT);
  const accountId = endpointUrl.hostname.split(".")[0];
  const jwt = await new SignJWT({ bucket: env.R2_BUCKET, scope, paths })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(accountId)
    .setIssuer(env.R2_READ_WRITE_ACCESS_KEY_ID)
    .setAudience(endpointUrl.host)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(env.R2_READ_WRITE_SECRET_ACCESS_KEY));
  return {
    type,
    access_key_id: env.R2_READ_WRITE_ACCESS_KEY_ID,
    secret_access_key: await sha256Hex(jwt),
    session_token: base64url.encode(`jwt/${jwt}`),
    expiration: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
