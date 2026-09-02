// Milestone 4 (docs/milestones.md): GET /v1/owner (docs/auth.md §4.1)
// through the real fetch() handler -- a real D1 owner row, a real Access
// session, and a real HS256 ticket the response's own ticket must verify
// against, not just a call into handleGetOwner() in isolation.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyTicket } from "../ownerTicket";
import { decodeBase64Secret } from "../ownerEndpoint";
import { mockAccessCertsEndpoint, signTestAccessToken } from "./testAccessToken";

function blob(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function insertOwnerRow(): Promise<{
  userHandleHash: Uint8Array;
  dbPrefixHash: Uint8Array;
  signPublicKey: Uint8Array;
  wrappedUmk: Uint8Array;
}> {
  const userHandleHash = await sha256(blob(32));
  const dbPrefixHash = await sha256(blob(32));
  const signPublicKey = blob(158); // representative SPKI DER size, not exact
  const wrappedUmk = blob(96);
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
      wrappedUmk,
      blob(64),
      blob(96),
      signPublicKey,
      blob(96),
      blob(64),
    )
    .run();
  return { userHandleHash, dbPrefixHash, signPublicKey, wrappedUmk };
}

function validTestClaims(): Record<string, unknown> {
  return {
    email: env.OWNER_EMAIL,
    aud: [env.CF_ACCESS_AUD],
    iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("GET /v1/owner", () => {
  it("rejects the request with no Access session", async () => {
    const response = await SELF.fetch("https://example.com/v1/owner");
    expect(response.status).toBe(401);
  });

  it("returns 401 when Access is verified but no owner row has been provisioned yet", async () => {
    const restore = mockAccessCertsEndpoint();
    try {
      const token = await signTestAccessToken(validTestClaims());
      const response = await SELF.fetch("https://example.com/v1/owner", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      });
      expect(response.status).toBe(401);
    } finally {
      restore();
    }
  });

  it("returns the wrapped owner material and a self-verifying ticket", async () => {
    const { userHandleHash, dbPrefixHash, signPublicKey, wrappedUmk } =
      await insertOwnerRow();
    const restore = mockAccessCertsEndpoint();
    try {
      const token = await signTestAccessToken(validTestClaims());
      const response = await SELF.fetch("https://example.com/v1/owner", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        wrapped_umk: string;
        sign_public_key: string;
        ticket: string;
      };
      expect(body.wrapped_umk).toBe(base64Encode(wrappedUmk));
      expect(body.sign_public_key).toBe(base64Encode(signPublicKey));

      const claims = await verifyTicket(
        body.ticket,
        decodeBase64Secret(env.TICKET_SIGNING_KEY),
      );
      expect(claims.sub).toBe(env.OWNER_EMAIL);
      const toBase64Url = (bytes: Uint8Array) =>
        base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(claims.user_handle_hash).toBe(toBase64Url(userHandleHash));
      expect(claims.db_binding_hash).toBe(toBase64Url(dbPrefixHash));
    } finally {
      restore();
    }
  });
});
