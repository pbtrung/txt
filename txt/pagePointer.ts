// $files for a page-version (docs/data_model.md's $files entity + commit
// protocol): `path` is the same plaintext value as pages.pageKey (deterministic,
// matches instant.perms.ts's string-prefix ownership check) -- the actual
// secret, this page-version's real R2 object key, is the *uploaded file's
// content* instead, wrapped via crypto.md's Blob format under path_key.
//
// Only the random key (generateRawKey's output) is what actually gets
// encrypted into that content -- r2Prefix is a pure, deterministic function
// of auth.id (already known to whoever is reading/writing their own page
// store), so baking it into the encrypted blob too would just be dead
// weight in every one of these blobs. The real R2 object address
// (`${r2Prefix}/${rawKey}`) gets assembled at the point of the actual GET/PUT
// instead -- see remotePageStore.ts.
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

export function encodePagePointerContent(
  cryptoEngine: CryptoEngine,
  pathKey: Buffer,
  rawKey: string,
): Buffer {
  return cryptoEngine.blobEncrypt(pathKey, Buffer.from(rawKey, "ascii"));
}

export function decodePagePointerContent(
  cryptoEngine: CryptoEngine,
  pathKey: Buffer,
  content: Buffer,
): string {
  return cryptoEngine.blobDecrypt(pathKey, content).toString("ascii");
}
