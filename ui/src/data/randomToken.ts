// Generates and wraps the random, opaque tokens this design uses for R2
// addressing (docs/data_model.md's txt.prefix and txtParts.path -- both a
// Crockford-base32-lowercase encoding of 32 random bytes, wrapped under the
// relevant key). Browser mirror of txt/randomToken.ts -- ui/ only ever
// unwraps existing tokens (it never mints a document or a part, only
// txt.ts does), but generateRandomToken/wrapToken are kept alongside
// unwrapToken anyway since a future ui/-side ingest path would need them,
// and it keeps this file a 1:1 port rather than an arbitrarily trimmed one.

import { encode as crockfordBase32Lowercase } from "./base32";
import * as blob from "../crypto/blob";
import { RAW_TOKEN_LEN } from "../crypto/constants";
import { randomBytes } from "../crypto/bytes";
import { bytesToBase64, base64ToBytes } from "../crypto/bytes";

export function generateRandomToken(): string {
  return crockfordBase32Lowercase(randomBytes(RAW_TOKEN_LEN));
}

// token is a bare random key string, not a structured payload -- no brotli
// step (crypto.md: "raw binary payloads are used as-is").
export async function wrapToken(
  ikm: Uint8Array,
  token: string,
): Promise<string> {
  const encrypted = await blob.encrypt(ikm, new TextEncoder().encode(token));
  return bytesToBase64(encrypted);
}

export async function unwrapToken(
  ikm: Uint8Array,
  blobBase64: string,
): Promise<string> {
  const decrypted = await blob.decrypt(ikm, base64ToBytes(blobBase64));
  return new TextDecoder().decode(decrypted);
}
