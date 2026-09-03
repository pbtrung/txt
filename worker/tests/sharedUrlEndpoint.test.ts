// POST /v1/shared-url, and the full create -> redeem -> revoke ->
// redeem-again lifecycle through the real
// fetch() handler. Credential minting is local (no network call to mock,
// worker/tests/r2CredentialsEndpoint.test.ts already covers that request
// shape in isolation); what's under test here is grant decryption, the
// active-row lookup, and the presigned URL's shape.
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { base64Encode } from "../base64";
import { sealGrant } from "../shareGrant";
import { createTestOwnerSession } from "./testOwnerSession";
import type { TestOwnerSession } from "./testOwnerSession";
import { mockAccessCertsEndpoint, signTestAccessToken } from "./testAccessToken";

function blob(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sharePath(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let i = 0; i < 52; i++)
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function insertDocument(): Promise<number> {
  async function insertKey(purpose: string): Promise<number> {
    const { meta } = await env.DB.prepare(
      "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES (?, ?, ?)",
    )
      .bind(purpose, blob(48), Date.now())
      .run();
    return meta.last_row_id;
  }
  const contentKeyId = await insertKey("content_key");
  const accessKeyId = await insertKey("access_key");
  const { meta } = await env.DB.prepare(
    `INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id, access_blob)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(Date.now(), contentKeyId, blob(32), accessKeyId, blob(32))
    .run();
  return meta.last_row_id;
}

let session: TestOwnerSession;
beforeAll(async () => {
  session = await createTestOwnerSession();
});

async function accessSession(): Promise<{ restore: () => void; headers: HeadersInit }> {
  const restore = mockAccessCertsEndpoint();
  const token = await signTestAccessToken({
    email: env.OWNER_EMAIL,
    aud: [env.CF_ACCESS_AUD],
    iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { restore, headers: { "Cf-Access-Jwt-Assertion": token } };
}

async function registerShare(
  documentId: number,
  shareId: Uint8Array,
  path: string,
  accessHeaders: HeadersInit,
): Promise<string> {
  const init = await session.signedRequest("POST", "/v1/shares", {
    document_id: documentId,
    share_id: base64UrlEncode(shareId),
    share_path: path,
    key_wrapped: base64Encode(blob(48)),
    owner_blob: base64Encode(blob(64)),
  });
  const response = await SELF.fetch("https://example.com/v1/shares", {
    ...init,
    headers: { ...init.headers, ...accessHeaders },
  });
  const body = (await response.json()) as { grant: string };
  return body.grant;
}

async function revokeShare(
  documentId: number,
  shareId: Uint8Array,
  path: string,
  accessHeaders: HeadersInit,
): Promise<Response> {
  const init = await session.signedRequest("DELETE", "/v1/shares", {
    document_id: documentId,
    share_id: base64UrlEncode(shareId),
    share_path: path,
  });
  return SELF.fetch("https://example.com/v1/shares", {
    ...init,
    headers: { ...init.headers, ...accessHeaders },
  });
}

async function redeem(shareId: Uint8Array, grant: string): Promise<Response> {
  return SELF.fetch("https://example.com/v1/shared-url", {
    method: "POST",
    body: JSON.stringify({ share_id: base64UrlEncode(shareId), grant }),
  });
}

describe("POST /v1/shared-url", () => {
  it("full lifecycle: create, redeem, revoke, redeem again fails 404", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const { restore: restoreAccess, headers } = await accessSession();
    try {
      const grant = await registerShare(documentId, shareId, path, headers);

      const redeemed = await redeem(shareId, grant);
      expect(redeemed.status).toBe(200);
      const body = (await redeemed.json()) as { url: string; expires_at: number };
      expect(body.url).toContain(`${session.dbPrefix}/shared/${path}`);
      expect(body.url).toContain("X-Amz-Signature=");
      expect(body.url).toContain("X-Amz-Expires=60");
      expect(redeemed.headers.get("Cache-Control")).toBe("no-store");

      const revoked = await revokeShare(documentId, shareId, path, headers);
      expect(revoked.status).toBe(204);

      const redeemedAgain = await redeem(shareId, grant);
      expect(redeemedAgain.status).toBe(404);
    } finally {
      restoreAccess();
    }
  });

  it("rejects a malformed grant with 400", async () => {
    const response = await redeem(blob(32), base64UrlEncode(blob(20)));
    expect(response.status).toBe(400);
  });

  it("rejects an unknown share_id (well-formed but unregistered) with 404", async () => {
    // A grant that decrypts fine but for a share_id with no shares row.
    const shareId = blob(32);
    const idHash = new Uint8Array(await crypto.subtle.digest("SHA-256", shareId));
    const grantBytes = await sealGrant(
      "some/object/path",
      idHash,
      await decodeTestShareGrantKey(),
    );
    const response = await redeem(shareId, base64UrlEncode(grantBytes));
    expect(response.status).toBe(404);
  });

  it("works with no Access session (capability possession is the authorization)", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const { restore: restoreAccess, headers } = await accessSession();
    try {
      const grant = await registerShare(documentId, shareId, path, headers);
      // redeem() (below) never sends Cf-Access-Jwt-Assertion at all -- this
      // call proves that absence doesn't block it, the same property
      // worker/tests/index.test.ts checks at the routing layer.
      const redeemed = await redeem(shareId, grant);
      expect(redeemed.status).toBe(200);
    } finally {
      restoreAccess();
    }
  });
});

async function decodeTestShareGrantKey(): Promise<Uint8Array> {
  const binary = atob(env.SHARE_GRANT_KEY);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
