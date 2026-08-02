// Browser mirror of txt/pagePointer.ts: $files for a page-version -- `path`
// is the same plaintext value as pages.pageKey (deterministic, matches
// instant.perms.ts's string-prefix ownership check) -- the actual secret,
// this page-version's real R2 object key, is wrapped separately (via
// crypto/blob.ts's Blob format under path_key) as the uploaded file's
// *content* instead of embedded in path -- see instantPageStore.ts.
//
// Only generateRawKey's output goes into that encrypted content -- r2Prefix
// is a pure, deterministic function of auth.id (already known to whoever is
// reading/writing their own page store), so baking it into the encrypted
// blob too would just be dead weight in every one of these blobs. The real
// R2 object address (`${r2Prefix}/${rawKey}`) is assembled at the point of
// the actual GET/PUT instead -- see instantPageStore.ts.
import { sha3_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "../crypto/bytes";
import * as base32 from "./base32";

const RAW_KEY_RANDOM_BYTES = 32;

// Plain SHA3-256, not HMAC -- a standard primitive with no leancrypto-
// specific behavior to replicate, same reasoning as the CLI's usernameHash.
export function computeR2Prefix(authId: string): string {
  return base32.encode(sha3_256(new TextEncoder().encode(authId)));
}

export function generateRawKey(): string {
  return base32.encode(randomBytes(RAW_KEY_RANDOM_BYTES));
}
