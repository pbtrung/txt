// docs/auth.md §2: the Worker verifies Cloudflare Access's
// Cf-Access-Jwt-Assertion header independently rather than trusting the
// edge unconditionally -- signature against the team domain's JWKS, `aud`,
// `iss`, `exp`, and `email` equal to the configured OWNER_EMAIL.
export interface AccessJwtClaims {
  email: string;
  aud: string | string[];
  exp: number;
  iss: string;
  [claim: string]: unknown;
}

interface Jwk {
  kid: string;
  kty: string;
  [field: string]: unknown;
}

interface Jwks {
  keys: Jwk[];
}

export class AccessVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessVerificationError";
  }
}

function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

export interface VerifyAccessJwtOptions {
  /** The exact `Cf-Access-Jwt-Assertion` header value. */
  token: string;
  /** Fetches the team domain's JWKS -- injected (rather than this module
   * calling `fetch` on a URL built from `CF_ACCESS_TEAM_DOMAIN` itself) so
   * tests can supply a fixed JWKS without mocking global `fetch`, and so
   * callers control caching (Access's own keys rotate infrequently; a
   * short-lived cache is a reasonable choice for `worker/api.ts` to make,
   * not this module's concern). */
  fetchJwks: () => Promise<unknown>;
  audience: string;
  issuer: string;
  ownerEmail: string;
  /** Unix seconds; defaults to the real clock. Injectable so expiry tests
   * don't need to wait for a real token to expire. */
  now?: number;
}

function isJwks(value: unknown): value is Jwks {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { keys?: unknown }).keys)
  );
}

/** Verifies an Access JWT end to end and returns its claims. Throws
 * `AccessVerificationError` for every failure mode -- malformed token,
 * unknown `kid`, bad signature, expired, wrong `aud`/`iss`/`email` -- so
 * callers can treat verification as one pass/fail gate without needing to
 * distinguish failure reasons for the caller (docs/auth.md §1: an
 * unauthenticated request never reaches the Worker's route handlers at
 * all in production, since Access itself blocks it; this verification is
 * the Worker's own defense-in-depth check, not the primary gate). */
export async function verifyAccessJwt(
  options: VerifyAccessJwtOptions,
): Promise<AccessJwtClaims> {
  const { token, fetchJwks, audience, issuer, ownerEmail } = options;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AccessVerificationError("malformed JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  try {
    header = decodeJsonSegment(headerB64) as { alg?: string; kid?: string };
  } catch {
    throw new AccessVerificationError("malformed JWT header");
  }
  if (header.alg !== "RS256") {
    throw new AccessVerificationError(`unsupported alg: ${String(header.alg)}`);
  }
  if (!header.kid) {
    throw new AccessVerificationError("missing kid");
  }

  const jwks = await fetchJwks();
  if (!isJwks(jwks)) {
    throw new AccessVerificationError("malformed JWKS response");
  }
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new AccessVerificationError("no matching key in JWKS");
  }

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new AccessVerificationError("failed to import JWKS key");
  }

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature,
    signedData,
  );
  if (!validSignature) {
    throw new AccessVerificationError("signature verification failed");
  }

  let claims: AccessJwtClaims;
  try {
    claims = decodeJsonSegment(payloadB64) as AccessJwtClaims;
  } catch {
    throw new AccessVerificationError("malformed JWT payload");
  }

  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new AccessVerificationError("token expired");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) {
    throw new AccessVerificationError("audience mismatch");
  }
  if (claims.iss !== issuer) {
    throw new AccessVerificationError("issuer mismatch");
  }
  if (claims.email !== ownerEmail) {
    throw new AccessVerificationError("email is not the configured owner");
  }

  return claims;
}
