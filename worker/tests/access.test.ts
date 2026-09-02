// Milestone 3 (docs/milestones.md): Access JWT verification
// (docs/auth.md §2), tested adversarially against a real RSA keypair and
// real crypto.subtle RS256 signing/verification -- not a mocked signature
// check.
import { beforeAll, describe, expect, it } from "vitest";
import { AccessVerificationError, verifyAccessJwt } from "../access";

const AUDIENCE = "test-access-application-aud";
const ISSUER = "https://test-team.cloudflareaccess.com";
const OWNER_EMAIL = "owner@example.com";
const KID = "test-key-id";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let publicJwk: JsonWebKey;
let privateKey: CryptoKey;

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

beforeAll(async () => {
  const keyPair = await generateRsaKeyPair();
  privateKey = keyPair.privateKey;
  publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
});

function fetchTestJwks(): Promise<unknown> {
  return Promise.resolve({ keys: [{ ...publicJwk, kid: KID }] });
}

async function signToken(
  claims: Record<string, unknown>,
  options: { kid?: string; alg?: string; key?: CryptoKey } = {},
): Promise<string> {
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? KID, typ: "JWT" };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.key ?? privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: OWNER_EMAIL,
    aud: [AUDIENCE],
    iss: ISSUER,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function verify(token: string, now?: number) {
  return verifyAccessJwt({
    token,
    fetchJwks: fetchTestJwks,
    audience: AUDIENCE,
    issuer: ISSUER,
    ownerEmail: OWNER_EMAIL,
    now,
  });
}

describe("verifyAccessJwt", () => {
  it("accepts a validly signed token for the configured owner", async () => {
    const token = await signToken(validClaims());
    const claims = await verify(token);
    expect(claims.email).toBe(OWNER_EMAIL);
  });

  it("rejects a token signed by a different key entirely", async () => {
    const otherKeyPair = await generateRsaKeyPair();
    const token = await signToken(validClaims(), { key: otherKeyPair.privateKey });

    await expect(verify(token)).rejects.toThrow(AccessVerificationError);
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const token = await signToken(validClaims());
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    const tamperedClaims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>;
    tamperedClaims.email = "attacker@example.com";
    const tamperedPayloadB64 = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify(tamperedClaims)),
    );
    const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;

    await expect(verify(tamperedToken)).rejects.toThrow(AccessVerificationError);
  });

  it("rejects an expired token", async () => {
    const token = await signToken(
      validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }),
    );

    await expect(verify(token)).rejects.toThrow(/expired/);
  });

  it("rejects a token that is not yet expired by the token's own clock but is by the check's injected clock", async () => {
    const exp = Math.floor(Date.now() / 1000) + 100;
    const token = await signToken(validClaims({ exp }));

    await expect(verify(token, exp + 1)).rejects.toThrow(/expired/);
  });

  it("rejects the wrong audience", async () => {
    const token = await signToken(validClaims({ aud: ["some-other-application"] }));

    await expect(verify(token)).rejects.toThrow(/audience/);
  });

  it("rejects the wrong issuer", async () => {
    const token = await signToken(
      validClaims({ iss: "https://not-the-team.cloudflareaccess.com" }),
    );

    await expect(verify(token)).rejects.toThrow(/issuer/);
  });

  it("rejects a verified identity that isn't the configured owner", async () => {
    const token = await signToken(validClaims({ email: "someone-else@example.com" }));

    await expect(verify(token)).rejects.toThrow(/owner/);
  });

  it("rejects an unknown kid not present in the JWKS", async () => {
    const token = await signToken(validClaims(), { kid: "not-a-real-key-id" });

    await expect(verify(token)).rejects.toThrow(/no matching key/);
  });

  it("rejects a non-RS256 alg (algorithm-confusion guard)", async () => {
    const token = await signToken(validClaims(), { alg: "none" });

    await expect(verify(token)).rejects.toThrow(/unsupported alg/);
  });

  it("rejects a malformed token that isn't three dot-separated segments", async () => {
    await expect(verify("not-a-jwt")).rejects.toThrow(/malformed JWT/);
  });
});
