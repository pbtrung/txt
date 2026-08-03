// Browser mirror of txt/pagePointer.ts: a page-version's real R2 object key
// (docs/data_model.md's pages entity + commit protocol) -- only the random
// key (generateRawKey's output) ever gets encrypted, via crypto/blob.ts's
// Blob format under path_key, base64-encoded directly into pages.path. No
// separate $files/pointer-file indirection -- `path` is a plain string field
// on the pages row itself.
//
// r2Prefix is left out of that encrypted blob entirely, since it's a pure,
// deterministic function of auth.id (already known to whoever is
// reading/writing their own page store) -- baking it in too would just be
// dead weight in every one of these blobs. The real R2 object address
// (`${r2Prefix}/${rawKey}`) is assembled at the point of the actual GET/PUT
// instead -- see instantPageStore.ts.
import { sha3_256 } from "@noble/hashes/sha3.js";
import * as blob from "../crypto/blob";
import { bytesToBase64, base64ToBytes, randomBytes } from "../crypto/bytes";
import * as base32 from "./base32";

const RAW_KEY_RANDOM_BYTES = 32;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

// Plain SHA3-256, not HMAC -- a standard primitive with no leancrypto-
// specific behavior to replicate, same reasoning as the CLI's usernameHash.
export function computeR2Prefix(authId: string): string {
  return base32.encode(sha3_256(new TextEncoder().encode(authId)));
}

export function generateRawKey(): string {
  return base32.encode(randomBytes(RAW_KEY_RANDOM_BYTES));
}

// rawKey is a bare random key string, not a structured payload -- no brotli
// step (crypto.md: "raw binary payloads are used as-is").
export async function encodePagePointerContent(
  pathKey: Uint8Array,
  rawKey: string,
): Promise<string> {
  const encrypted = await blob.encrypt(pathKey, utf8.encode(rawKey));
  return bytesToBase64(encrypted);
}

export async function decodePagePointerContent(
  pathKey: Uint8Array,
  path: string,
): Promise<string> {
  const decrypted = await blob.decrypt(pathKey, base64ToBytes(path));
  return utf8Decoder.decode(decrypted);
}
