// Verifies the currently-served app matches what ui/scripts/sign-assets.mjs
// signed at build time, using asset_sign_key from the user's own local
// config file -- that key never appears in any built asset, so a
// compromised deployment can serve tampered content but can't forge a
// matching HMAC for it.
//
// Chain of trust:
//   1. index.html, then leancrypto.js, then leancrypto.wasm are each checked
//      with native WebCrypto HMAC-SHA512 against creds.assetHashes (three
//      concatenated 64-byte hashes, in that order) -- this depends on
//      nothing this app itself serves. leancrypto.js/.wasm get this same
//      native treatment rather than leancrypto's own SHA3: using leancrypto
//      to verify leancrypto's own bytes before they're trusted would be
//      circular.
//   2. Every other manifested asset (index.html's embedded manifest, safe to
//      trust once step 1 passes) is checked with HMAC-SHA3-512 via
//      leancrypto, safe now that leancrypto.js/.wasm are themselves verified.
//
// This catches tampering that happens between a build and what the browser
// receives (CDN/edge cache poisoning, in-flight modification, a stale/rolled
// -back deploy). It can't stop an attacker who can rewrite the deployed
// bundle itself from also deleting this very check, since the check ships
// as part of that same bundle -- closing that gap needs an enforcement point
// outside this app (e.g. a browser extension, or SRI for the parts of this
// that the browser can enforce before any of this code runs).

import { ASSET_HMAC_LEN } from "../crypto/constants";
import { base64ToBytes, bytesEqual } from "../crypto/bytes";
import { hmacSha3_512 } from "../crypto/leancryptoLoader";
import type { Creds } from "../data/creds";
import { verbose } from "../log";
import { parseAssetManifest, type AssetManifest } from "./manifest";

export class AssetIntegrityError extends Error {}

const MANIFEST_ELEMENT_ID = "asset-manifest";

async function fetchBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new AssetIntegrityError(`failed to fetch ${path} for integrity check: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function hmacSha512Native(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // TypeScript's DOM lib types BufferSource as ArrayBufferView<ArrayBuffer>
  // specifically -- key/data may be backed by a plain ArrayBufferLike (e.g.
  // Uint8Array.prototype.slice's result), so re-wrap through a fresh
  // ArrayBuffer-backed copy to satisfy that.
  const keyBuf = new Uint8Array(key);
  const dataBuf = new Uint8Array(data);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, dataBuf));
}

function extractManifest(html: string): AssetManifest {
  const match = html.match(new RegExp(`<script[^>]*id=["']${MANIFEST_ELEMENT_ID}["'][^>]*>([\\s\\S]*?)</script>`));
  if (!match) {
    throw new AssetIntegrityError("index.html has no embedded asset manifest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new AssetIntegrityError("index.html's asset manifest is not valid JSON");
  }
  return parseAssetManifest(parsed);
}

function checkHmac(actual: Uint8Array, expected: Uint8Array, what: string): void {
  if (!bytesEqual(actual, expected)) {
    throw new AssetIntegrityError(`integrity check failed for ${what} -- it may have been tampered with`);
  }
  verbose(`asset integrity OK: ${what}`);
}

async function verifyFetchedEntry(
  path: string,
  expected: Uint8Array,
  compute: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<void> {
  verbose(`asset integrity: verifying ${path}`);
  const bytes = await fetchBytes(`/${path}`);
  checkHmac(await compute(bytes), expected, path);
}

/** Splits creds.assetHashes into its three concatenated 64-byte hashes, in
 * (index.html, leancrypto.js, leancrypto.wasm) order -- see sign-assets.mjs. */
function splitAssetHashes(assetHashes: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  return [
    assetHashes.slice(0, ASSET_HMAC_LEN),
    assetHashes.slice(ASSET_HMAC_LEN, ASSET_HMAC_LEN * 2),
    assetHashes.slice(ASSET_HMAC_LEN * 2, ASSET_HMAC_LEN * 3),
  ];
}

/** Verifies index.html, leancrypto.js, and leancrypto.wasm against
 * creds.assetSignKey/assetHashes, then every other asset index.html's
 * embedded manifest lists. Throws AssetIntegrityError on the first mismatch
 * or malformed manifest. */
export async function verifyAssetIntegrity(creds: Creds): Promise<void> {
  const [indexHtmlHash, leancryptoJsHash, leancryptoWasmHash] = splitAssetHashes(creds.assetHashes);

  verbose("asset integrity: verifying index.html");
  const indexBytes = await fetchBytes("/");
  checkHmac(await hmacSha512Native(creds.assetSignKey, indexBytes), indexHtmlHash, "index.html");
  await verifyFetchedEntry("leancrypto.js", leancryptoJsHash, (bytes) => hmacSha512Native(creds.assetSignKey, bytes));
  await verifyFetchedEntry("leancrypto.wasm", leancryptoWasmHash, (bytes) =>
    hmacSha512Native(creds.assetSignKey, bytes),
  );

  const manifest = extractManifest(new TextDecoder().decode(indexBytes));
  const manifestEntries = Object.entries(manifest["sha3-512"]);
  for (const [path, expectedBase64] of manifestEntries) {
    await verifyFetchedEntry(path, base64ToBytes(expectedBase64), (bytes) => hmacSha3_512(creds.assetSignKey, bytes));
  }
  verbose(`asset integrity: all ${manifestEntries.length + 3} asset(s) verified OK`);
}
