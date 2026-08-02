// Browser mirror of txt/pagePointer.ts: $files for a page-version -- `path`
// is the same plaintext value as pages.pageKey (deterministic, matches
// instant.perms.ts's string-prefix ownership check) -- the actual secret,
// this page-version's real R2 object key, is wrapped separately (via
// crypto/blob.ts's Blob format under path_key) as the uploaded file's
// *content* instead of embedded in path -- see instantPageStore.ts.
import { sha3_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "../crypto/bytes";
import * as base32 from "./base32";

const RAW_PATH_RANDOM_BYTES = 32;

// Plain SHA3-256, not HMAC -- a standard primitive with no leancrypto-
// specific behavior to replicate, same reasoning as the CLI's usernameHash.
export function computeR2Prefix(authId: string): string {
  return base32.encode(sha3_256(new TextEncoder().encode(authId)));
}

export function generateRawPath(r2Prefix: string): string {
  return `${r2Prefix}/${base32.encode(randomBytes(RAW_PATH_RANDOM_BYTES))}`;
}
