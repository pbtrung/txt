import { slh_dsa_sha2_256f } from "@noble/post-quantum/slh-dsa.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VerificationError, verifyAssets } from "./verify";

const ASSET_BASE_URL = "https://cdn.example.com/app";
const INDEX_HTML = new TextEncoder().encode("<!doctype html><div id=root></div>");
const APP_JS = new TextEncoder().encode("console.log('app')");

async function sha512Base64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", bytes);
  return Buffer.from(digest).toString("base64");
}

async function buildFixture() {
  const { secretKey, publicKey } = slh_dsa_sha2_256f.keygen();
  const manifest = {
    "index.html": await sha512Base64(INDEX_HTML),
    "assets/app.js": await sha512Base64(APP_JS),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const sig = slh_dsa_sha2_256f.sign(manifestBytes, secretKey);
  return { publicKey, manifestBytes, sig, manifest };
}

function fakeFetch(files: Record<string, Uint8Array<ArrayBuffer>>) {
  return vi.fn(async (url: string) => {
    const path = url.slice(`${ASSET_BASE_URL}/`.length);
    const bytes = files[path];
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(bytes);
  });
}

describe("verifyAssets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies a correctly signed manifest and every listed asset", async () => {
    const { publicKey, manifestBytes, sig } = await buildFixture();
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        "manifest.json": manifestBytes,
        "manifest.sig": sig,
        "index.html": INDEX_HTML,
        "assets/app.js": APP_JS,
      }),
    );

    const progress: string[] = [];
    const verified = await verifyAssets(ASSET_BASE_URL, publicKey, (step) => progress.push(step));

    expect(Array.from(verified.get("index.html")!)).toEqual(Array.from(INDEX_HTML));
    expect(Array.from(verified.get("assets/app.js")!)).toEqual(Array.from(APP_JS));
    expect(progress).toEqual(["fetching-manifest", "verifying-signature", "fetching-assets", "verifying-hashes"]);
  });

  it("rejects a manifest whose signature doesn't verify", async () => {
    const { manifestBytes, sig } = await buildFixture();
    const { publicKey: wrongPublicKey } = slh_dsa_sha2_256f.keygen();
    vi.stubGlobal("fetch", fakeFetch({ "manifest.json": manifestBytes, "manifest.sig": sig }));

    await expect(verifyAssets(ASSET_BASE_URL, wrongPublicKey, () => {})).rejects.toThrow(VerificationError);
    await expect(verifyAssets(ASSET_BASE_URL, wrongPublicKey, () => {})).rejects.toThrow(/signature check/);
  });

  it("rejects a manifest signed correctly but tampered with after signing", async () => {
    const { publicKey, sig } = await buildFixture();
    const tampered = new TextEncoder().encode(JSON.stringify({ "index.html": "not-a-real-hash" }));
    vi.stubGlobal("fetch", fakeFetch({ "manifest.json": tampered, "manifest.sig": sig }));

    await expect(verifyAssets(ASSET_BASE_URL, publicKey, () => {})).rejects.toThrow(/signature check/);
  });

  it("rejects an asset whose bytes don't match its recorded hash", async () => {
    const { publicKey, manifestBytes, sig } = await buildFixture();
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        "manifest.json": manifestBytes,
        "manifest.sig": sig,
        "index.html": INDEX_HTML,
        "assets/app.js": new TextEncoder().encode("console.log('tampered')"),
      }),
    );

    await expect(verifyAssets(ASSET_BASE_URL, publicKey, () => {})).rejects.toThrow(/assets\/app\.js/);
  });

  it("rejects when a manifest-listed asset is missing", async () => {
    const { publicKey, manifestBytes, sig } = await buildFixture();
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "manifest.json": manifestBytes, "manifest.sig": sig, "index.html": INDEX_HTML }),
    );

    await expect(verifyAssets(ASSET_BASE_URL, publicKey, () => {})).rejects.toThrow(/HTTP 404/);
  });

  it("rejects a manifest that lists no files", async () => {
    const { secretKey, publicKey } = slh_dsa_sha2_256f.keygen();
    const emptyManifestBytes = new TextEncoder().encode(JSON.stringify({}));
    const sig = slh_dsa_sha2_256f.sign(emptyManifestBytes, secretKey);
    vi.stubGlobal("fetch", fakeFetch({ "manifest.json": emptyManifestBytes, "manifest.sig": sig }));

    await expect(verifyAssets(ASSET_BASE_URL, publicKey, () => {})).rejects.toThrow(/lists no files/);
  });
});
