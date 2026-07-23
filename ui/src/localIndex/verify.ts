// The verification core of local_index.html (see ui/scripts/build-integrity.mjs
// for how manifest.json/manifest.sig/the embedded public key get produced, and
// docs/ui.md's local-boot design for why this exists as a separate, never-
// deployed file rather than living inside dist/ itself: dist/'s own index.html
// is served by the CDN, so a verifier shipped inside it could be tampered away
// by whatever compromised that CDN. local_index.html never touches the CDN's
// index.html at all -- it's opened directly (e.g. via file://) and only ever
// trusts bytes it has independently hashed/signature-checked itself.
//
// Two-stage trust: manifest.json's own bytes are trusted only once
// slh_dsa_sha2_256f.verify() confirms manifest.sig over them (both fetched as
// raw bytes -- the signature covers manifest.json's literal bytes, so it's
// verified before any JSON.parse happens, not after a re-serialization that
// could disagree byte-for-byte with what was actually signed). Once that
// passes, every path manifest.json lists gets fetched and SHA-512'd (native
// Web Crypto, no external package -- same asset_base_url dist/ files as
// build-integrity.mjs already hashed) and compared against its recorded
// digest.

import { slh_dsa_sha2_256f } from "@noble/post-quantum/slh-dsa.js";

import { bytesToBase64 } from "../crypto/bytes";

export class VerificationError extends Error {}

export type VerifyProgress = "fetching-manifest" | "verifying-signature" | "fetching-assets" | "verifying-hashes";

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new VerificationError(`${url}: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function sha512Base64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", bytes);
  return bytesToBase64(new Uint8Array(digest));
}

/** Fetches, signature-checks, and hash-verifies every file manifest.json
 * lists under assetBaseUrl. Returns the verified bytes keyed by their
 * manifest path (e.g. "index.html", "assets/index-abc123.js") so callers
 * never need to re-fetch anything already checked here. */
export async function verifyAssets(
  assetBaseUrl: string,
  publicKey: Uint8Array,
  onProgress: (step: VerifyProgress) => void,
): Promise<Map<string, Uint8Array>> {
  onProgress("fetching-manifest");
  const base = assetBaseUrl.endsWith("/") ? assetBaseUrl : `${assetBaseUrl}/`;
  const [manifestBytes, sigBytes] = await Promise.all([
    fetchBytes(`${base}manifest.json`),
    fetchBytes(`${base}manifest.sig`),
  ]);

  onProgress("verifying-signature");
  if (!slh_dsa_sha2_256f.verify(sigBytes, manifestBytes, publicKey)) {
    throw new VerificationError("manifest.json failed its SLH-DSA signature check -- refusing to load anything");
  }

  let manifest: Record<string, string>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, string>;
  } catch (err) {
    throw new VerificationError(`manifest.json is signed correctly but isn't valid JSON: ${String(err)}`);
  }
  const paths = Object.keys(manifest);
  if (paths.length === 0) {
    throw new VerificationError("manifest.json lists no files");
  }

  onProgress("fetching-assets");
  const fetched = await Promise.all(paths.map(async (path) => [path, await fetchBytes(`${base}${path}`)] as const));

  onProgress("verifying-hashes");
  const verified = new Map<string, Uint8Array>();
  for (const [path, bytes] of fetched) {
    const actual = await sha512Base64(bytes);
    const expected = manifest[path];
    if (actual !== expected) {
      throw new VerificationError(`${path} failed its SHA-512 check -- expected ${expected}, got ${actual}`);
    }
    verified.set(path, bytes);
  }

  return verified;
}
