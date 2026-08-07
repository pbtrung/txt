// Generates and wraps the random, opaque tokens this design uses for R2
// addressing (docs/data_model.md's txt.prefix and txtParts.path -- both a
// Crockford-base32-lowercase encoding of 32 random bytes, wrapped under the
// relevant key). Shared by txt.ts --migrate (which mints fresh ones) and
// --clean-bucket/--update-db-prefixHash (which only ever unwrap existing
// ones).
import { randomBytes } from "node:crypto";
import { crockfordBase32Lowercase } from "./base32.ts";
import * as C from "./constants.ts";
import type { CryptoEngine } from "./crypto.ts";

export function generateRandomToken(): string {
  return crockfordBase32Lowercase(randomBytes(C.RAW_TOKEN_LEN));
}

// token is a bare random key string, not a structured payload -- no brotli
// step (crypto.md: "raw binary payloads are used as-is").
export function wrapToken(
  crypto: CryptoEngine,
  ikm: Buffer,
  token: string,
): string {
  return crypto
    .blobEncrypt(ikm, Buffer.from(token, "ascii"), false)
    .toString("base64");
}

export function unwrapToken(
  crypto: CryptoEngine,
  ikm: Buffer,
  blobBase64: string,
): string {
  return crypto
    .blobDecrypt(ikm, Buffer.from(blobBase64, "base64"), false)
    .toString("ascii");
}
