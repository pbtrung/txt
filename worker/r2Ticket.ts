import { base64url, jwtVerify, SignJWT } from "jose";

import type { Account } from "./ctl";
import { decodeBase64, encodeBase64 } from "./base64";

const AUDIENCE = "r2-token";
const ALGORITHM = "HS256";
const TICKET_TTL_SECONDS = 24 * 60 * 60;
const TICKET_VERSION = 1;
const HANDLE_HASH_BYTES = 32;
const BINDING_HASH_BYTES = 64;
const TICKET_ID_BYTES = 32;

export interface R2Ticket {
  subject: string;
  userHandleHash: Uint8Array;
  signVersion: number;
  signAlgorithm: string;
  signPublicKey: Uint8Array;
  dbBindingHash: Uint8Array;
  ticketId: string;
}

export async function issueR2Ticket(
  account: Account,
  uid: string,
  secret: string,
): Promise<string> {
  const ticketId = encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
  const claims = accountClaims(account);
  return new SignJWT({ v: TICKET_VERSION, ...claims })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setSubject(uid)
    .setAudience(AUDIENCE)
    .setJti(ticketId)
    .setIssuedAt()
    .setExpirationTime(`${TICKET_TTL_SECONDS}s`)
    .sign(ticketSecret(secret));
}

export async function verifyR2Ticket(
  ticket: string,
  secret: string,
): Promise<R2Ticket | null> {
  try {
    const verified = await jwtVerify(ticket, ticketSecret(secret), {
      algorithms: [ALGORITHM],
      audience: AUDIENCE,
    });
    return parseTicketClaims(verified.payload);
  } catch {
    return null;
  }
}

function accountClaims(account: Account): Record<string, unknown> {
  requireBytes(account.userHandleHash, HANDLE_HASH_BYTES, "user handle hash");
  requireBytes(account.dbBindingHash, BINDING_HASH_BYTES, "database binding hash");
  return {
    user_handle_hash: base64url.encode(decodeBase64(account.userHandleHash)),
    sign_version: account.signVersion,
    sign_algorithm: account.signAlgorithm,
    sign_public_key: base64url.encode(decodeBase64(account.signPublicKey)),
    db_binding_hash: base64url.encode(decodeBase64(account.dbBindingHash)),
  };
}

function parseTicketClaims(payload: Record<string, unknown>): R2Ticket {
  requireStandardClaims(payload);
  const ticket = {
    subject: payload.sub as string,
    userHandleHash: decodeClaim(payload.user_handle_hash, HANDLE_HASH_BYTES),
    signVersion: payload.sign_version as number,
    signAlgorithm: payload.sign_algorithm as string,
    signPublicKey: decodeClaim(payload.sign_public_key),
    dbBindingHash: decodeClaim(payload.db_binding_hash, BINDING_HASH_BYTES),
    ticketId: payload.jti as string,
  };
  requireTicketId(ticket.ticketId);
  return ticket;
}

function requireStandardClaims(payload: Record<string, unknown>): void {
  if (payload.v !== TICKET_VERSION) throw new Error("invalid ticket version");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("invalid ticket subject");
  }
  if (typeof payload.jti !== "string") throw new Error("invalid ticket id");
  if (payload.sign_version !== 1) throw new Error("invalid signing version");
  if (typeof payload.sign_algorithm !== "string") {
    throw new Error("invalid signing algorithm");
  }
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) {
    throw new Error("invalid ticket lifetime");
  }
  if ((payload.exp as number) - (payload.iat as number) !== TICKET_TTL_SECONDS) {
    throw new Error("invalid ticket lifetime");
  }
}

function decodeClaim(value: unknown, length?: number): Uint8Array {
  if (typeof value !== "string") throw new Error("invalid binary claim");
  const decoded = base64url.decode(value);
  if (length !== undefined && decoded.byteLength !== length) {
    throw new Error("invalid binary claim length");
  }
  return decoded;
}

function requireTicketId(value: string): void {
  const bytes = decodeBase64(value);
  if (bytes.byteLength !== TICKET_ID_BYTES || encodeBase64(bytes) !== value) {
    throw new Error("invalid ticket id");
  }
}

function ticketSecret(value: string): Uint8Array {
  const bytes = decodeBase64(value);
  if (bytes.byteLength < 32) throw new Error("ticket secret is too short");
  return bytes;
}

function requireBytes(value: string, length: number, name: string): void {
  if (decodeBase64(value).byteLength !== length) {
    throw new Error(`${name} must be ${length} bytes`);
  }
}
