// docs/auth.md §4.1: a self-contained, 24-hour HS256 ticket the Worker
// issues after verifying Access, so later requests (docs/auth.md §4.2)
// don't each need a fresh D1 read of the owner row -- the ticket carries
// what proof verification needs, authenticated by the Worker's own
// signature over it.
export interface TicketClaims {
  v: 1;
  aud: "r2-token";
  sub: string; // owner email
  jti: string; // base64url 32 random bytes
  user_handle_hash: string; // base64url SHA-256(user_handle)
  sign_public_key: string; // base64url SPKI DER
  db_binding_hash: string; // base64url SHA-256(db_prefix)
  iat: number;
  exp: number;
}

const TICKET_TTL_SECONDS = 24 * 60 * 60;

export class TicketVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketVerificationError";
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(signingKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    signingKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Issues a fresh ticket for the given claims (everything except `v`,
 * `aud`, `iat`, `exp`, which this function fills in). */
export async function issueTicket(
  claims: Pick<
    TicketClaims,
    "sub" | "jti" | "user_handle_hash" | "sign_public_key" | "db_binding_hash"
  >,
  signingKey: Uint8Array,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const fullClaims: TicketClaims = {
    v: 1,
    aud: "r2-token",
    ...claims,
    iat: now,
    exp: now + TICKET_TTL_SECONDS,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(fullClaims)),
  );
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await hmacKey(signingKey);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verifies a ticket's HMAC and expiry, and returns its claims. The exact
 * compact token string (not the parsed claims) is also what
 * `docs/crypto.md`'s canonical proof bytes hash over -- callers that need
 * both should keep the original `token` string around rather than
 * re-serializing these claims. */
export async function verifyTicket(
  token: string,
  signingKey: Uint8Array,
  now: number = Math.floor(Date.now() / 1000),
): Promise<TicketClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TicketVerificationError("malformed ticket");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const key = await hmacKey(signingKey);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) {
    throw new TicketVerificationError("ticket signature verification failed");
  }

  let claims: TicketClaims;
  try {
    claims = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64)),
    ) as TicketClaims;
  } catch {
    throw new TicketVerificationError("malformed ticket payload");
  }

  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new TicketVerificationError("ticket expired");
  }

  return claims;
}
