import { describe, expect, it } from "vitest";

import { ManifestError, parseAssetManifest } from "./manifest";

describe("parseAssetManifest", () => {
  it("parses a valid manifest", () => {
    const manifest = parseAssetManifest({
      "sha3-512": { "assets/app.js": "def=" },
    });
    expect(manifest["sha3-512"]["assets/app.js"]).toBe("def=");
  });

  it("rejects a non-object", () => {
    expect(() => parseAssetManifest("not an object")).toThrow(ManifestError);
    expect(() => parseAssetManifest(null)).toThrow(ManifestError);
  });

  it("rejects a missing sha3-512 field", () => {
    expect(() => parseAssetManifest({})).toThrow(ManifestError);
  });

  it("rejects a non-string hash value", () => {
    expect(() => parseAssetManifest({ "sha3-512": { "assets/app.js": 123 } })).toThrow(ManifestError);
  });
});
