// Milestone 4 (docs/milestones.md): the layer standing between "past
// Access" and "can mutate the library" -- tested adversarially against a
// real P-521 keypair and real crypto.subtle sign/verify, exercising the
// full ticket-issuance-then-proof flow rather than mocking either half.
import { beforeEach, describe, expect, it } from "vitest";
import { issueTicket, verifyTicket } from "../ownerTicket";
import type { TicketClaims } from "../ownerTicket";
import { buildCanonicalProofBytes, verifyProof } from "../ownerProof";
import type { ProofEnvelope } from "../ownerProof";

const TICKET_SIGNING_KEY = crypto.getRandomValues(new Uint8Array(32));
const DB_PREFIX = "a".repeat(52);
const OWNER_EMAIL = "owner@example.com";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function exportSpki(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey("spki", key)) as ArrayBuffer);
}

let signingKeyPair: CryptoKeyPair;
let userHandle: Uint8Array;
let ticketToken: string;
let ticketClaims: TicketClaims;

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function signProof(params: {
  ticket?: string;
  userHandle?: Uint8Array;
  dbPrefix?: string;
  method: string;
  path: string;
  body?: Uint8Array;
  expiresAt?: number;
  requestId?: Uint8Array;
  key?: CryptoKey;
}): Promise<ProofEnvelope> {
  const requestId = params.requestId ?? crypto.getRandomValues(new Uint8Array(32));
  const expiresAt = params.expiresAt ?? Math.floor(Date.now() / 1000) + 30;
  const canonical = await buildCanonicalProofBytes({
    exactCompactTicket: params.ticket ?? ticketToken,
    userHandle: params.userHandle ?? userHandle,
    expiresAt,
    requestId,
    dbPrefix: params.dbPrefix ?? DB_PREFIX,
    method: params.method,
    path: params.path,
    body: params.body ?? new Uint8Array(0),
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-512" },
    params.key ?? signingKeyPair.privateKey,
    canonical,
  );
  return {
    version: 1,
    expires_at: expiresAt,
    request_id: base64Encode(requestId),
    signature: base64Encode(new Uint8Array(signature)),
  };
}

beforeEach(async () => {
  signingKeyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-521" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  userHandle = crypto.getRandomValues(new Uint8Array(32));
  const signPublicKeySpki = await exportSpki(signingKeyPair.publicKey);

  ticketToken = await issueTicket(
    {
      sub: OWNER_EMAIL,
      jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
      user_handle_hash: await sha256Base64Url(userHandle),
      sign_public_key: base64UrlEncode(signPublicKeySpki),
      db_binding_hash: await sha256Base64Url(new TextEncoder().encode(DB_PREFIX)),
    },
    TICKET_SIGNING_KEY,
  );
  ticketClaims = await verifyTicket(ticketToken, TICKET_SIGNING_KEY);
});

async function verify(
  overrides: Partial<Parameters<typeof verifyProof>[0]> & {
    method: string;
    path: string;
  },
): Promise<void> {
  await verifyProof({
    ticketClaims,
    exactCompactTicket: ticketToken,
    proof:
      overrides.proof ??
      (await signProof({ method: overrides.method, path: overrides.path })),
    userHandle,
    dbPrefix: DB_PREFIX,
    body: new Uint8Array(0),
    ...overrides,
  });
}

describe("ownerTicket", () => {
  it("issues a ticket the same secret can verify", async () => {
    expect(ticketClaims.sub).toBe(OWNER_EMAIL);
    expect(ticketClaims.aud).toBe("r2-token");
  });

  it("rejects a ticket verified against the wrong signing key", async () => {
    const wrongKey = crypto.getRandomValues(new Uint8Array(32));
    await expect(verifyTicket(ticketToken, wrongKey)).rejects.toThrow(/signature/);
  });

  it("rejects an expired ticket", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredTicket = await issueTicket(
      {
        sub: OWNER_EMAIL,
        jti: "x",
        user_handle_hash: "x",
        sign_public_key: "x",
        db_binding_hash: "x",
      },
      TICKET_SIGNING_KEY,
      now - 25 * 60 * 60, // issued 25 hours ago, past the 24-hour TTL
    );
    await expect(verifyTicket(expiredTicket, TICKET_SIGNING_KEY, now)).rejects.toThrow(
      /expired/,
    );
  });
});

describe("verifyProof", () => {
  it("accepts a validly signed proof for the exact request it targets", async () => {
    await expect(
      verify({ method: "DELETE", path: "/v1/bookmarks/5" }),
    ).resolves.toBeUndefined();
  });

  // The specific cross-resource-replay gap docs/auth.md §4.2 closes:
  // binding method+path+body, not just an abstract "operation name".
  it("rejects a proof for one resource when replayed against a different one", async () => {
    const proofForBookmark5 = await signProof({
      method: "DELETE",
      path: "/v1/bookmarks/5",
    });

    await expect(
      verify({ method: "DELETE", path: "/v1/bookmarks/7", proof: proofForBookmark5 }),
    ).rejects.toThrow(/signature/);
  });

  it("rejects a proof replayed against a different HTTP method on the same path", async () => {
    const proofForDelete = await signProof({
      method: "DELETE",
      path: "/v1/bookmarks/5",
    });

    await expect(
      verify({ method: "GET", path: "/v1/bookmarks/5", proof: proofForDelete }),
    ).rejects.toThrow(/signature/);
  });

  it("rejects a proof whose signed body doesn't match the request's actual body", async () => {
    const proof = await signProof({
      method: "POST",
      path: "/v1/bookmarks",
      body: new TextEncoder().encode('{"cfi":"original"}'),
    });

    await expect(
      verify({
        method: "POST",
        path: "/v1/bookmarks",
        proof,
        body: new TextEncoder().encode('{"cfi":"tampered"}'),
      }),
    ).rejects.toThrow(/signature/);
  });

  it("rejects an expired proof", async () => {
    const proof = await signProof({
      method: "GET",
      path: "/v1/x",
      expiresAt: Math.floor(Date.now() / 1000) - 5,
    });

    await expect(verify({ method: "GET", path: "/v1/x", proof })).rejects.toThrow(
      /expired/,
    );
  });

  it("rejects a proof whose expiry is further than 60 seconds in the future", async () => {
    const proof = await signProof({
      method: "GET",
      path: "/v1/x",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(verify({ method: "GET", path: "/v1/x", proof })).rejects.toThrow(
      /too far/,
    );
  });

  it("rejects a proof built against a stale/expired ticket (fails at ticket verification, before proof verification runs)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleTicket = await issueTicket(
      {
        sub: OWNER_EMAIL,
        jti: "x",
        user_handle_hash: await sha256Base64Url(userHandle),
        sign_public_key: base64UrlEncode(await exportSpki(signingKeyPair.publicKey)),
        db_binding_hash: await sha256Base64Url(new TextEncoder().encode(DB_PREFIX)),
      },
      TICKET_SIGNING_KEY,
      now - 25 * 60 * 60,
    );

    await expect(verifyTicket(staleTicket, TICKET_SIGNING_KEY, now)).rejects.toThrow(
      /expired/,
    );
  });

  it("rejects a structurally valid but wrong-length signature", async () => {
    const proof = await signProof({ method: "GET", path: "/v1/x" });
    proof.signature = base64Encode(crypto.getRandomValues(new Uint8Array(64))); // not 132 bytes

    await expect(verify({ method: "GET", path: "/v1/x", proof })).rejects.toThrow(
      /132 bytes/,
    );
  });

  it("rejects a wrong-length request_id", async () => {
    const proof = await signProof({ method: "GET", path: "/v1/x" });
    proof.request_id = base64Encode(crypto.getRandomValues(new Uint8Array(16)));

    await expect(verify({ method: "GET", path: "/v1/x", proof })).rejects.toThrow(
      /request_id/,
    );
  });

  it("rejects a proof for the right request but the wrong db_prefix (db_binding_hash mismatch)", async () => {
    await expect(
      verify({
        method: "GET",
        path: "/v1/x",
        dbPrefix: "b".repeat(52), // doesn't match the ticket's db_binding_hash
      }),
    ).rejects.toThrow(/db_prefix/);
  });

  it("rejects a proof presenting the wrong user_handle (user_handle_hash mismatch)", async () => {
    await expect(
      verify({
        method: "GET",
        path: "/v1/x",
        userHandle: crypto.getRandomValues(new Uint8Array(32)),
      }),
    ).rejects.toThrow(/user_handle/);
  });

  it("rejects a proof signed by a key other than the one bound to the ticket", async () => {
    const otherKeyPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-521" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const proof = await signProof({
      method: "GET",
      path: "/v1/x",
      key: otherKeyPair.privateKey,
    });

    await expect(verify({ method: "GET", path: "/v1/x", proof })).rejects.toThrow(
      /signature/,
    );
  });
});
