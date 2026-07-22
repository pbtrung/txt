// The asset manifest ui/scripts/sign-assets.mjs embeds into dist/index.html
// (see verifyAssets.ts): every built asset's HMAC-SHA3-512, keyed by
// asset_sign_key, EXCEPT index.html/leancrypto.js/leancrypto.wasm -- those
// three are verified separately via creds.assetHashes (native HMAC-SHA512,
// computed without depending on leancrypto, which is itself one of them).
// Paths are dist-relative, forward-slashed, no leading "/".

export interface AssetManifest {
  "sha3-512": Record<string, string>;
}

export class ManifestError extends Error {}

function requireStringMap(data: Record<string, unknown>, field: string): Record<string, string> {
  const value = data[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(`asset manifest's ${field} must be an object`);
  }
  const entries = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [path, hash] of Object.entries(entries)) {
    if (typeof hash !== "string" || hash.length === 0) {
      throw new ManifestError(`asset manifest's ${field}["${path}"] must be a non-empty string`);
    }
    out[path] = hash;
  }
  return out;
}

/** Parses the JSON manifest embedded in dist/index.html's #asset-manifest script. */
export function parseAssetManifest(json: unknown): AssetManifest {
  if (typeof json !== "object" || json === null) {
    throw new ManifestError("asset manifest must be a JSON object");
  }
  const data = json as Record<string, unknown>;
  return {
    "sha3-512": requireStringMap(data, "sha3-512"),
  };
}
