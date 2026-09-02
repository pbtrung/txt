// docs/auth.md §4.1: GET /v1/owner reads the singleton `owner` row and
// issues a fresh ticket. This is a read (Access-JWT-gated only, no proof
// of possession needed, docs/auth.md §2) -- it returns wrapped material,
// never anything unwrapped.
import { issueTicket } from "./ownerTicket";
import type { AccessJwtClaims } from "./access";
import { base64Decode, base64Encode, base64UrlEncode } from "./base64";

/** Decodes a standard-base64 secret string (the convention every `wrangler
 * secret put` value in this app uses, matching `openssl rand -base64 32`'s
 * own output) into raw bytes. */
export function decodeBase64Secret(value: string): Uint8Array {
  return base64Decode(value);
}

interface OwnerRow {
  wrapped_umk: ArrayBuffer;
  sign_public_key: ArrayBuffer;
  wrapped_sign_private_key: ArrayBuffer;
  kem_public_key: ArrayBuffer;
  wrapped_kem_private_key: ArrayBuffer;
  encrypted_credentials: ArrayBuffer;
  user_handle_hash: ArrayBuffer;
  db_prefix_hash: ArrayBuffer;
}

export async function handleGetOwner(
  env: Env,
  access: AccessJwtClaims,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT wrapped_umk, sign_public_key, wrapped_sign_private_key,
            kem_public_key, wrapped_kem_private_key, encrypted_credentials,
            user_handle_hash, db_prefix_hash
     FROM owner WHERE singleton = 1`,
  ).first<OwnerRow>();

  if (!row) {
    // Provisioning hasn't run yet (docs/deployment.md §3) -- not a client
    // error, but also not something to distinguish from "unauthorized" in
    // the response (docs/auth.md §2's uniform-failure reasoning applies
    // here too: no reason to tell an unprovisioned deployment's caller
    // more than a provisioned one's).
    return new Response("Unauthorized", { status: 401 });
  }

  const ticket = await issueTicket(
    {
      sub: access.email,
      jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
      user_handle_hash: base64UrlEncode(row.user_handle_hash),
      sign_public_key: base64UrlEncode(row.sign_public_key),
      db_binding_hash: base64UrlEncode(row.db_prefix_hash),
    },
    decodeBase64Secret(env.TICKET_SIGNING_KEY),
  );

  return Response.json({
    wrapped_umk: base64Encode(row.wrapped_umk),
    sign_public_key: base64Encode(row.sign_public_key),
    wrapped_sign_private_key: base64Encode(row.wrapped_sign_private_key),
    kem_public_key: base64Encode(row.kem_public_key),
    wrapped_kem_private_key: base64Encode(row.wrapped_kem_private_key),
    encrypted_credentials: base64Encode(row.encrypted_credentials),
    ticket,
  });
}
