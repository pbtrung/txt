// A page-version's real R2 object key (docs/data_model.md's pages entity +
// commit protocol): only the random key (generateRawKey's output) ever gets
// encrypted, via crypto.md's Blob format under path_key -- the result is
// base64-encoded directly into pages.path. r2Prefix is left out of that
// encrypted blob entirely, since it's a pure, deterministic function of
// auth.id (already known to whoever is reading/writing their own page
// store) -- baking it in too would just be dead weight in every one of
// these blobs. The real R2 object address (`${r2Prefix}/${rawKey}`) gets
// assembled at the point of the actual GET/PUT instead -- see
// remotePageStore.ts.
import { createHash, randomBytes } from "node:crypto";
import { crockfordBase32Lowercase } from "./base32.ts";
import type { CryptoEngine } from "./crypto.ts";

const RAW_KEY_RANDOM_BYTES = 32;

// Plain SHA3-256, not HMAC -- a standard primitive with no leancrypto-specific
// behavior to replicate, same reasoning as CryptoEngine's usernameHash.
export function computeR2Prefix(authId: string): string {
  return crockfordBase32Lowercase(
    createHash("sha3-256").update(authId, "utf8").digest(),
  );
}

export function generateRawKey(): string {
  return crockfordBase32Lowercase(randomBytes(RAW_KEY_RANDOM_BYTES));
}

// rawKey is a bare random key string, not a structured payload -- no brotli
// step (crypto.md: "raw binary payloads are used as-is").
export function encodePagePointerContent(
  cryptoEngine: CryptoEngine,
  pathKey: Buffer,
  rawKey: string,
): Buffer {
  return cryptoEngine.blobEncrypt(pathKey, Buffer.from(rawKey, "ascii"), false);
}

export function decodePagePointerContent(
  cryptoEngine: CryptoEngine,
  pathKey: Buffer,
  content: Buffer,
): string {
  return cryptoEngine.blobDecrypt(pathKey, content, false).toString("ascii");
}
