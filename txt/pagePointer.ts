// $files.path encoding (docs/data_model.md's $files entity + commit
// protocol): every account's R2 objects live under a deterministic prefix,
// and each page-version's real R2 key is encrypted before being embedded in
// the InstantDB-visible path string.
import { createHash, randomBytes } from "node:crypto";
import { crockfordBase32Lowercase } from "./base32.ts";
import type { CryptoEngine } from "./crypto.ts";

const RAW_PATH_RANDOM_BYTES = 32;

// Plain SHA3-256, not HMAC -- a standard primitive with no leancrypto-specific
// behavior to replicate, same reasoning as CryptoEngine's usernameHash.
export function computeR2Prefix(authId: string): string {
  return crockfordBase32Lowercase(
    createHash("sha3-256").update(authId, "utf8").digest(),
  );
}

export function generateRawPath(r2Prefix: string): string {
  return `${r2Prefix}/${crockfordBase32Lowercase(randomBytes(RAW_PATH_RANDOM_BYTES))}`;
}

// $files.path = "${authId}:" + path_key-encrypted rawPath, base64url-encoded.
export function encodePagePath(
  cryptoEngine: CryptoEngine,
  pathKey: Buffer,
  authId: string,
  rawPath: string,
): string {
  const blob = cryptoEngine.blobEncrypt(pathKey, Buffer.from(rawPath, "ascii"));
  return `${authId}:${base64url(blob)}`;
}

export function decodePagePath(
  cryptoEngine: CryptoEngine,
  pathKey: Buffer,
  path: string,
): string {
  const encoded = path.slice(path.indexOf(":") + 1);
  const blob = base64urlDecode(encoded);
  return cryptoEngine.blobDecrypt(pathKey, blob).toString("ascii");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
