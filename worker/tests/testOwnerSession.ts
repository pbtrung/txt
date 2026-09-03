// Shared test-only helper: a real D1 owner row plus a matching ticket and
// a function that signs a proof for a given mutating request, so
// documentsEndpoint.test.ts and bookmarksEndpoint.test.ts can drive the
// real fetch() handler end to end rather than calling handlers directly.
import { env } from "cloudflare:test";
import { issueTicket } from "../ownerTicket";
import { buildCanonicalProofBytes } from "../ownerProof";
import type { ProofEnvelope } from "../ownerProof";
import { base64Decode, base64Encode, base64UrlEncode } from "../base64";

function blob(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export interface TestOwnerSession {
  userHandle: Uint8Array;
  dbPrefix: string;
  /** Builds a `RequestInit` for a mutating request against `path`, with a
   * validly signed ticket + proof covering the exact method/path/body. */
  signedRequest(
    method: string,
    path: string,
    extraBody?: Record<string, unknown>,
  ): Promise<RequestInit>;
}

export async function createTestOwnerSession(): Promise<TestOwnerSession> {
  const signingKeyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-521" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const userHandle = blob(32);
  const dbPrefix = "a".repeat(52);
  const signPublicKey = new Uint8Array(
    (await crypto.subtle.exportKey("spki", signingKeyPair.publicKey)) as ArrayBuffer,
  );
  const userHandleHash = await sha256(userHandle);
  const dbPrefixHash = await sha256(new TextEncoder().encode(dbPrefix));

  await env.DB.prepare(
    `INSERT INTO owner (singleton, created_at, owner_email_hash, db_prefix_hash,
       user_handle_hash, wrapped_umk, kem_public_key, wrapped_kem_private_key,
       sign_version, sign_algorithm, sign_public_key, wrapped_sign_private_key,
       encrypted_credentials)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, 1, 'ECDSA-P521-SHA512', ?, ?, ?)`,
  )
    .bind(
      Date.now(),
      await sha256(new TextEncoder().encode(env.OWNER_EMAIL)),
      dbPrefixHash,
      userHandleHash,
      blob(96),
      blob(64),
      blob(96),
      signPublicKey,
      blob(96),
      blob(64),
    )
    .run();

  const ticketToken = await issueTicket(
    {
      sub: env.OWNER_EMAIL!,
      jti: base64UrlEncode(blob(32)),
      user_handle_hash: base64UrlEncode(userHandleHash),
      sign_public_key: base64UrlEncode(signPublicKey),
      db_binding_hash: base64UrlEncode(dbPrefixHash),
    },
    base64Decode(env.TICKET_SIGNING_KEY),
  );

  async function signedRequest(
    method: string,
    path: string,
    extraBody: Record<string, unknown> = {},
  ): Promise<RequestInit> {
    const bodyObject = {
      user_handle: base64Encode(userHandle),
      db_prefix: dbPrefix,
      ...extraBody,
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObject));
    const requestId = blob(32);
    const expiresAt = Math.floor(Date.now() / 1000) + 30;
    const canonical = await buildCanonicalProofBytes({
      exactCompactTicket: ticketToken,
      userHandle,
      expiresAt,
      requestId,
      dbPrefix,
      method,
      path,
      body: bodyBytes,
    });
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-512" },
      signingKeyPair.privateKey,
      canonical,
    );
    const proof: ProofEnvelope = {
      version: 1,
      expires_at: expiresAt,
      request_id: base64Encode(requestId),
      signature: base64Encode(new Uint8Array(signature)),
    };
    return {
      method,
      headers: {
        "X-Owner-Ticket": ticketToken,
        "X-Owner-Proof": JSON.stringify(proof),
        "Content-Type": "application/json",
      },
      body: bodyBytes,
    };
  }

  return { userHandle, dbPrefix, signedRequest };
}
