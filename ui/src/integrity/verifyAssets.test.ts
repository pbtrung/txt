import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64, concatBytes } from "../crypto/bytes";
import { hmacSha3_512 } from "../crypto/leancryptoLoader";
import type { Creds } from "../data/creds";
import { setVerbose } from "../log";
import { AssetIntegrityError, verifyAssetIntegrity } from "./verifyAssets";

function fakeResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

async function hmacSha512Native(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const keyBuf = new Uint8Array(key);
  const dataBuf = new Uint8Array(data);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, dataBuf));
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fakeCreds(assetHashes: Uint8Array, assetSignKey: Uint8Array): Creds {
  return {
    tursoDatabaseUrl: "",
    tursoAuthToken: "",
    username: "",
    usernameLookupKey: new Uint8Array(32),
    password: "",
    displayName: "",
    userRootKey: new Uint8Array(256),
    assetSignKey,
    assetHashes,
  };
}

const KEY = new Uint8Array(64).fill(7);

async function buildFixture() {
  const leancryptoJs = textBytes("fake leancrypto.js contents");
  const leancryptoWasm = textBytes("fake leancrypto.wasm contents");
  const appJs = textBytes("fake app.js contents");
  const manifest = {
    "sha3-512": { "assets/app.js": bytesToBase64(await hmacSha3_512(KEY, appJs)) },
  };
  const html =
    `<html><body><div id="root"></div>` +
    `<script id="asset-manifest" type="application/json">${JSON.stringify(manifest)}</script>` +
    `</body></html>`;
  const htmlBytes = textBytes(html);

  // In this order -- index.html, leancrypto.js, leancrypto.wasm -- matching
  // sign-assets.mjs and verifyAssets.ts's splitAssetHashes.
  const assetHashes = concatBytes(
    await hmacSha512Native(KEY, htmlBytes),
    await hmacSha512Native(KEY, leancryptoJs),
    await hmacSha512Native(KEY, leancryptoWasm),
  );
  return { leancryptoJs, leancryptoWasm, appJs, htmlBytes, assetHashes };
}

function mockFetch(files: Record<string, Uint8Array>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const path = String(input);
      const bytes = files[path];
      if (!bytes) return { ok: false, status: 404 } as unknown as Response;
      return fakeResponse(bytes);
    }),
  );
}

describe("verifyAssetIntegrity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setVerbose(true);
  });

  it("logs each asset it verifies, including index.html, when verbose is on", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setVerbose(true);
    const { leancryptoJs, leancryptoWasm, appJs, htmlBytes, assetHashes } = await buildFixture();
    mockFetch({
      "/": htmlBytes,
      "/leancrypto.js": leancryptoJs,
      "/leancrypto.wasm": leancryptoWasm,
      "/assets/app.js": appJs,
    });

    await verifyAssetIntegrity(fakeCreds(assetHashes, KEY));

    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity: verifying index.html");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity OK: index.html");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity: verifying leancrypto.js");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity OK: leancrypto.js");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity: verifying leancrypto.wasm");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity OK: leancrypto.wasm");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity: verifying assets/app.js");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity OK: assets/app.js");
    expect(console.log).toHaveBeenCalledWith("[verbose]", "asset integrity: all 4 asset(s) verified OK");
  });

  it("passes when every asset matches", async () => {
    const { leancryptoJs, leancryptoWasm, appJs, htmlBytes, assetHashes } = await buildFixture();
    mockFetch({
      "/": htmlBytes,
      "/leancrypto.js": leancryptoJs,
      "/leancrypto.wasm": leancryptoWasm,
      "/assets/app.js": appJs,
    });

    await expect(verifyAssetIntegrity(fakeCreds(assetHashes, KEY))).resolves.toBeUndefined();
  });

  it("fails when index.html itself doesn't match assetHashes", async () => {
    const { leancryptoJs, leancryptoWasm, appJs, htmlBytes } = await buildFixture();
    mockFetch({
      "/": htmlBytes,
      "/leancrypto.js": leancryptoJs,
      "/leancrypto.wasm": leancryptoWasm,
      "/assets/app.js": appJs,
    });

    const wrongHashes = new Uint8Array(192).fill(1);
    await expect(verifyAssetIntegrity(fakeCreds(wrongHashes, KEY))).rejects.toThrow(AssetIntegrityError);
    await expect(verifyAssetIntegrity(fakeCreds(wrongHashes, KEY))).rejects.toThrow(/index\.html/);
  });

  it("fails when leancrypto.js is tampered with", async () => {
    const { leancryptoWasm, appJs, htmlBytes, assetHashes } = await buildFixture();
    const tamperedLeancrypto = textBytes("tampered!");
    mockFetch({
      "/": htmlBytes,
      "/leancrypto.js": tamperedLeancrypto,
      "/leancrypto.wasm": leancryptoWasm,
      "/assets/app.js": appJs,
    });

    await expect(verifyAssetIntegrity(fakeCreds(assetHashes, KEY))).rejects.toThrow(/leancrypto\.js/);
  });

  it("fails when leancrypto.wasm is tampered with", async () => {
    const { leancryptoJs, appJs, htmlBytes, assetHashes } = await buildFixture();
    const tamperedLeancrypto = textBytes("tampered!");
    mockFetch({
      "/": htmlBytes,
      "/leancrypto.js": leancryptoJs,
      "/leancrypto.wasm": tamperedLeancrypto,
      "/assets/app.js": appJs,
    });

    await expect(verifyAssetIntegrity(fakeCreds(assetHashes, KEY))).rejects.toThrow(/leancrypto\.wasm/);
  });

  it("fails when a sha3-512-manifested asset is tampered with", async () => {
    const { leancryptoJs, leancryptoWasm, htmlBytes, assetHashes } = await buildFixture();
    const tamperedAppJs = textBytes("tampered!");
    mockFetch({
      "/": htmlBytes,
      "/leancrypto.js": leancryptoJs,
      "/leancrypto.wasm": leancryptoWasm,
      "/assets/app.js": tamperedAppJs,
    });

    await expect(verifyAssetIntegrity(fakeCreds(assetHashes, KEY))).rejects.toThrow(/assets\/app\.js/);
  });

  it("fails when index.html has no embedded manifest", async () => {
    const html = textBytes("<html><body>no manifest here</body></html>");
    const leancryptoJs = textBytes("fake leancrypto.js contents");
    const leancryptoWasm = textBytes("fake leancrypto.wasm contents");
    const assetHashes = concatBytes(
      await hmacSha512Native(KEY, html),
      await hmacSha512Native(KEY, leancryptoJs),
      await hmacSha512Native(KEY, leancryptoWasm),
    );
    mockFetch({ "/": html, "/leancrypto.js": leancryptoJs, "/leancrypto.wasm": leancryptoWasm });

    await expect(verifyAssetIntegrity(fakeCreds(assetHashes, KEY))).rejects.toThrow(/no embedded asset manifest/);
  });
});
