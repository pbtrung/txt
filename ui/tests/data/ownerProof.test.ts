// docs/auth.md §4.2 / docs/crypto.md "Owner-proof signatures": real P-521
// sign/verify against a hand-built expected canonical form, so this and
// worker/ownerProof.ts's independent implementation are cross-checked by
// construction rather than merely by matching prose.
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCanonicalProofBytes,
  P521_SIGNATURE_BYTES,
  signOwnerProof,
  type OwnerSigningIdentity,
} from "../../src/data/ownerProof";
import { fromBase64 } from "../../src/util/base64";

const DB_PREFIX = "a".repeat(52);
const TICKET = "header.payload.signature";

let signing: OwnerSigningIdentity;
let publicKey: CryptoKey;

beforeEach(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-521" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signing = {
    ticket: TICKET,
    userHandle: crypto.getRandomValues(new Uint8Array(32)),
    privateKey: pair.privateKey,
  };
  publicKey = pair.publicKey;
});

async function verifyEnvelope(
  body: Uint8Array,
  envelope: Awaited<ReturnType<typeof signOwnerProof>>["envelope"],
  method: string,
  path: string,
): Promise<boolean> {
  const canonical = await buildCanonicalProofBytes({
    ticket: signing.ticket,
    userHandle: signing.userHandle,
    expiresAt: envelope.expires_at,
    requestId: fromBase64(envelope.request_id),
    dbPrefix: DB_PREFIX,
    method,
    path,
    body,
  });
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-512" },
    publicKey,
    fromBase64(envelope.signature),
    canonical,
  );
}

describe("signOwnerProof", () => {
  it("produces a signature that verifies against the exact body it returns", async () => {
    const { envelope, body } = await signOwnerProof(
      signing,
      DB_PREFIX,
      "POST",
      "/v1/bookmarks",
      {
        document_id: 5,
      },
    );

    expect(envelope.version).toBe(1);
    expect(fromBase64(envelope.signature).byteLength).toBe(P521_SIGNATURE_BYTES);
    expect(fromBase64(envelope.request_id).byteLength).toBe(32);
    await expect(verifyEnvelope(body, envelope, "POST", "/v1/bookmarks")).resolves.toBe(
      true,
    );
  });

  it("embeds user_handle and db_prefix in the returned body", async () => {
    const { body } = await signOwnerProof(signing, DB_PREFIX, "DELETE", "/v1/shares", {
      share_id: "abc",
    });
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    >;
    expect(parsed.share_id).toBe("abc");
    expect(parsed.db_prefix).toBe(DB_PREFIX);
    expect(typeof parsed.user_handle).toBe("string");
  });

  it("fails verification if the signature is checked against a different path", async () => {
    const { envelope, body } = await signOwnerProof(
      signing,
      DB_PREFIX,
      "DELETE",
      "/v1/bookmarks/5",
      {},
    );
    await expect(
      verifyEnvelope(body, envelope, "DELETE", "/v1/bookmarks/7"),
    ).resolves.toBe(false);
  });

  it("fails verification if the body is tampered with after signing", async () => {
    const { envelope, body } = await signOwnerProof(
      signing,
      DB_PREFIX,
      "POST",
      "/v1/x",
      {
        value: "original",
      },
    );
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(body).replace("original", "tampered"),
    );
    await expect(verifyEnvelope(tampered, envelope, "POST", "/v1/x")).resolves.toBe(
      false,
    );
  });

  it("produces a fresh request_id and signature on every call", async () => {
    const first = await signOwnerProof(signing, DB_PREFIX, "GET", "/v1/x", {});
    const second = await signOwnerProof(signing, DB_PREFIX, "GET", "/v1/x", {});
    expect(first.envelope.request_id).not.toBe(second.envelope.request_id);
    expect(first.envelope.signature).not.toBe(second.envelope.signature);
  });
});
