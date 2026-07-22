#!/usr/bin/env node
// Runs after `vite build` (see package.json's build script) to sign every
// file under dist/ with asset_sign_key (64 random bytes -- generate one with
// `openssl rand -base64 64`, keep it only in a local config file and CI
// secrets, never commit it or let it reach a built asset). Reads that key
// from either `--admin-creds <path>` (a JSON file with an asset_sign_key
// field -- e.g. creds/admin_creds.json) or the ASSET_SIGN_KEY env var, in
// that order. See src/integrity/verifyAssets.ts for the client-side check
// this feeds and why the split below exists:
//   - index.html, leancrypto.js, leancrypto.wasm: HMAC-SHA512 (Node's native
//     crypto -- the browser verifies these the same way, via WebCrypto,
//     before ever trusting leancrypto's own SHA3 implementation). These
//     three digests are concatenated, in that order, into asset_hashes.
//   - every other file: HMAC-SHA3-512 (matches leancrypto's lc_hmac output
//     bit-for-bit -- cross-checked in src/crypto/leancryptoLoader.test.ts --
//     so the browser can verify these with leancrypto once it's trusted),
//     embedded directly in index.html as a manifest. Forging a *new*
//     manifest to match tampered assets requires a new valid HMAC over the
//     new index.html bytes too, which requires asset_sign_key -- so nothing
//     about the manifest's own location needs to be kept secret or
//     external, only the key does.

import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const INDEX_HTML_PATH = join(DIST_DIR, "index.html");
const MANIFEST_ELEMENT_ID = "asset-manifest";
// Verified separately via asset_hashes (native HMAC-SHA512), not through the
// sha3-512 manifest -- leancrypto.js/.wasm can't safely verify themselves.
const EXCLUDED_FROM_MANIFEST = new Set(["leancrypto.js", "leancrypto.wasm"]);

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--admin-creds") return { adminCredsPath: argv[i + 1] };
    if (arg.startsWith("--admin-creds=")) return { adminCredsPath: arg.slice("--admin-creds=".length) };
  }
  return { adminCredsPath: undefined };
}

function loadAdminCreds(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to read/parse --admin-creds file ${path}: ${err.message}`);
  }
}

function decodeKey(raw, source) {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 64) {
    throw new Error(`${source} must decode to 64 bytes, got ${key.length}`);
  }
  return key;
}

/** Returns { key, adminCreds } -- adminCreds is the parsed --admin-creds
 * file (so main() can write asset_hashes back into it), or null when
 * signing from the ASSET_SIGN_KEY env var instead. */
function loadKey(adminCredsPath) {
  if (adminCredsPath) {
    const adminCreds = loadAdminCreds(adminCredsPath);
    const raw = adminCreds.asset_sign_key;
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(`${adminCredsPath} has no asset_sign_key field`);
    }
    return { key: decodeKey(raw, `${adminCredsPath}'s asset_sign_key`), adminCreds };
  }

  const raw = process.env.ASSET_SIGN_KEY;
  if (!raw) {
    throw new Error(
      "No signing key found. Pass --admin-creds <path to a JSON file with an asset_sign_key field> or set the " +
        "ASSET_SIGN_KEY env var. Generate a key with `openssl rand -base64 64` -- keep it only in a local config " +
        "file and CI secrets, never in the repo or a built asset.",
    );
  }
  return { key: decodeKey(raw, "ASSET_SIGN_KEY"), adminCreds: null };
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function hmacBytes(algorithm, key, data) {
  return createHmac(algorithm, key).update(data).digest();
}

function hmacBase64(algorithm, key, data) {
  return hmacBytes(algorithm, key, data).toString("base64");
}

// path.relative uses the platform separator; dist paths are always compared
// as posix (forward-slash) in the manifest and by the browser fetching them.
function toPosixPath(p) {
  return process.platform === "win32" ? p.split("\\").join("/") : p;
}

function buildManifest(key) {
  const manifest = { "sha3-512": {} };
  for (const absPath of listFilesRecursive(DIST_DIR)) {
    if (absPath === INDEX_HTML_PATH) continue;
    const relPath = toPosixPath(relative(DIST_DIR, absPath));
    if (EXCLUDED_FROM_MANIFEST.has(relPath)) continue;
    const bytes = readFileSync(absPath);
    manifest["sha3-512"][relPath] = hmacBase64("sha3-512", key, bytes);
  }
  return manifest;
}

function injectManifest(html, manifest) {
  if (html.includes(`id="${MANIFEST_ELEMENT_ID}"`)) {
    throw new Error("dist/index.html already has an embedded asset manifest -- run this script only once per build");
  }
  const json = JSON.stringify(manifest).replace(/<\/script/gi, "<\\/script");
  const tag = `    <script id="${MANIFEST_ELEMENT_ID}" type="application/json">${json}</script>\n  `;
  if (!html.includes("</body>")) {
    throw new Error("dist/index.html has no </body> to inject the asset manifest before");
  }
  return html.replace("</body>", `${tag}</body>`);
}

function main() {
  const { adminCredsPath } = parseArgs(process.argv.slice(2));
  const { key, adminCreds } = loadKey(adminCredsPath);
  const manifest = buildManifest(key);

  const originalHtml = readFileSync(INDEX_HTML_PATH, "utf8");
  const signedHtml = injectManifest(originalHtml, manifest);
  writeFileSync(INDEX_HTML_PATH, signedHtml, "utf8");

  const leancryptoJsBytes = readFileSync(join(DIST_DIR, "leancrypto.js"));
  const leancryptoWasmBytes = readFileSync(join(DIST_DIR, "leancrypto.wasm"));

  // In this order -- index.html, leancrypto.js, leancrypto.wasm -- see
  // src/integrity/verifyAssets.ts's splitAssetHashes.
  const assetHashes = Buffer.concat([
    hmacBytes("sha512", key, Buffer.from(signedHtml, "utf8")),
    hmacBytes("sha512", key, leancryptoJsBytes),
    hmacBytes("sha512", key, leancryptoWasmBytes),
  ]).toString("base64");

  const assetCount = Object.keys(manifest["sha3-512"]).length + EXCLUDED_FROM_MANIFEST.size;

  if (adminCreds) {
    adminCreds.asset_hashes = assetHashes;
    writeFileSync(adminCredsPath, JSON.stringify(adminCreds, null, 2) + "\n", "utf8");
    console.log(`Signed ${assetCount} asset(s). Wrote asset_hashes to ${adminCredsPath}.`);
  } else {
    console.log(`Signed ${assetCount} asset(s).`);
    console.log('Paste this into your UI config file\'s "asset_hashes" field:');
    console.log(assetHashes);
  }
}

main();
