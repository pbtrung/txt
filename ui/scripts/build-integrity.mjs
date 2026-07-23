#!/usr/bin/env node
// Runs after `vite build` (see package.json's build script) to produce the
// locally-verified boot flow described in CLAUDE.md/README.md:
//   1. Adds integrity="sha512-..." (SRI, native Node crypto -- no external
//      package) to dist/index.html's entry <script type=module src>/<link
//      rel=stylesheet href> tags, hardening the separate direct-CDN-visit
//      path (a plain browser hit on the CDN URL, bypassing local_index.html
//      entirely) against a MITM/cache swapping the script/css while leaving
//      index.html itself unchanged.
//   2. SHA-512s every file under dist/ (including the now-SRI-tagged
//      index.html) into dist/manifest.json.
//   3. Writes dist/_headers (Cloudflare Pages' response-header config file --
//      also understood by Netlify) narrowing the direct-CDN-visit CSP's
//      connect-src from index.html's own <meta> tag's deliberately-open '*'
//      down to 'self' plus the Turso/R2 host patterns the app actually talks
//      to. _headers is a deploy-time config file, never itself served as a
//      fetchable path, so it's written after buildManifest() runs, not
//      before -- same reason manifest.json/manifest.sig are, below.
//   4. Loads (or, only if absent, generates) an SLH-DSA-SHA2-256f keypair
//      (@noble/post-quantum) from --admin-creds's slhdsa_256f_priv_key,
//      signs manifest.json's literal bytes with it, and writes the raw
//      signature to dist/manifest.sig. A freshly generated secret key gets
//      written back into that same admin-creds file (nothing else in it is
//      touched) -- an existing key is always reused so a rebuild doesn't
//      silently invalidate every local_index.html copy already in the wild.
//   5. Bundles ui/src/localIndex/main.ts (via Vite's own build API, iife
//      format, so @noble/post-quantum and its own dependencies get inlined
//      into one self-contained script -- no CDN/npm fetch at verify-time)
//      with the derived public key and --admin-creds's asset_base_url baked
//      in, and writes the result to creds/local_index.html -- never dist/,
//      so it's never uploaded to the CDN. This is the file a user opens
//      directly (e.g. via file://) to verify everything before the real app
//      ever renders; see ui/src/localIndex/ for that verification logic and
//      why it can't live inside dist/ itself.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { slh_dsa_sha2_256f } from "@noble/post-quantum/slh-dsa.js";
import { build } from "vite";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(UI_DIR, "dist");
const INDEX_HTML_PATH = join(DIST_DIR, "index.html");
const CREDS_DIR = resolve(UI_DIR, "..", "creds");
const LOCAL_INDEX_PATH = join(CREDS_DIR, "local_index.html");
const VERIFIER_ENTRY = join(UI_DIR, "src", "localIndex", "main.ts");

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

function sha512Base64(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
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

// path.relative uses the platform separator; dist paths are always compared
// as posix (forward-slash) in the manifest and by the browser fetching them.
function toPosixPath(p) {
  return process.platform === "win32" ? p.split("\\").join("/") : p;
}

/** Adds integrity="sha512-<base64>" to every tag matching tagRegex that
 * carries a urlAttrName pointing at a dist/ file. */
function addIntegrityToTags(html, tagRegex, urlAttrName) {
  return html.replace(tagRegex, (tag) => {
    if (/\sintegrity=/.test(tag)) {
      throw new Error(`tag already has an integrity attribute -- run this script only once per build: ${tag}`);
    }
    const match = new RegExp(`\\s${urlAttrName}="([^"]+)"`).exec(tag);
    if (!match) return tag;
    const assetPath = match[1].replace(/^\//, "");
    const bytes = readFileSync(join(DIST_DIR, assetPath));
    return tag.slice(0, -1) + ` integrity="sha512-${sha512Base64(bytes)}">`;
  });
}

function addSri(html) {
  let out = addIntegrityToTags(html, /<script[^>]*\stype="module"[^>]*>/g, "src");
  out = addIntegrityToTags(out, /<link[^>]*\srel="stylesheet"[^>]*>/g, "href");
  return out;
}

function buildManifest() {
  const manifest = {};
  for (const absPath of listFilesRecursive(DIST_DIR)) {
    const relPath = toPosixPath(relative(DIST_DIR, absPath));
    manifest[relPath] = sha512Base64(readFileSync(absPath));
  }
  return manifest;
}

// Mirrors dist/index.html's own <meta> CSP (see that file's comment for why
// every other directive is what it is) except connect-src, narrowed here
// from that meta tag's deliberately-open '*' down to 'self' plus the two
// host patterns the app actually talks to (a Turso database in the
// aws-us-east-1 region, and R2's standard custom-domain pattern). A real
// HTTP response header and a <meta> CSP both apply at once and combine by
// intersection, so this tightens the effective policy for a direct CDN visit
// without having to touch the per-account-agnostic meta tag itself.
const DIST_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' https://*.aws-us-east-1.turso.io https://*.r2.cloudflarestorage.com; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self';";

function writeHeadersFile() {
  writeFileSync(join(DIST_DIR, "_headers"), `/*\n  Content-Security-Policy: ${DIST_CSP}\n`, "utf8");
}

/** Reuses slhdsa_256f_priv_key from adminCreds if it's a non-empty base64
 * string; otherwise generates a fresh keypair. Never regenerates when a key
 * is already present. */
function loadOrCreateKeypair(adminCreds) {
  const raw = adminCreds.slhdsa_256f_priv_key;
  if (typeof raw === "string" && raw.length > 0) {
    const secretKey = Buffer.from(raw, "base64");
    return { secretKey, publicKey: slh_dsa_sha2_256f.getPublicKey(secretKey), generated: false };
  }
  const { secretKey, publicKey } = slh_dsa_sha2_256f.keygen();
  return { secretKey, publicKey, generated: true };
}

function requireAssetBaseUrl(adminCreds, adminCredsPath) {
  const url = adminCreds.asset_base_url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`${adminCredsPath} has no asset_base_url field`);
  }
  return url;
}

/** Bundles ui/src/localIndex/main.ts into one self-contained IIFE script
 * (no CDN/npm fetch at verify-time) with the public key/asset_base_url
 * baked in via Vite's `define`. Uses Vite's own build API rather than a
 * separate bundler dependency -- this project already depends on Vite. */
async function bundleVerifier(assetBaseUrl, publicKeyB64) {
  const result = await build({
    root: UI_DIR,
    configFile: false,
    logLevel: "warn",
    define: {
      __ASSET_BASE_URL__: JSON.stringify(assetBaseUrl),
      __SLHDSA_PUBKEY_B64__: JSON.stringify(publicKeyB64),
    },
    build: {
      write: false,
      target: "es2022",
      lib: {
        entry: VERIFIER_ENTRY,
        formats: ["iife"],
        name: "LocalIndexBoot",
        fileName: () => "local-index-boot.js",
      },
    },
  });
  const output = Array.isArray(result) ? result.flatMap((r) => r.output) : result.output;
  const chunk = output.find((item) => item.type === "chunk");
  if (!chunk) {
    throw new Error("Vite's local_index.html bundle produced no JS chunk");
  }
  return chunk.code;
}

function buildLocalIndexHtml(bundleCode) {
  // Escaping </script -- same reason as the old sign-assets.mjs's JSON
  // injection: bundleCode is untrusted-shape text (could in principle
  // contain a string literal with that sequence) that must not be able to
  // close the surrounding <script> tag early.
  const safeCode = bundleCode.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Verifying…</title>
  </head>
  <body>
    <div id="root"></div>
    <script>${safeCode}</script>
  </body>
</html>
`;
}

async function main() {
  const { adminCredsPath } = parseArgs(process.argv.slice(2));
  if (!adminCredsPath) {
    throw new Error(
      "Pass --admin-creds <path to admin_creds.json> -- this build step needs its asset_base_url and " +
        "slhdsa_256f_priv_key fields.",
    );
  }
  const adminCreds = loadAdminCreds(adminCredsPath);
  const assetBaseUrl = requireAssetBaseUrl(adminCreds, adminCredsPath);
  const { secretKey, publicKey, generated } = loadOrCreateKeypair(adminCreds);

  const originalHtml = readFileSync(INDEX_HTML_PATH, "utf8");
  writeFileSync(INDEX_HTML_PATH, addSri(originalHtml), "utf8");

  const manifest = buildManifest();
  writeHeadersFile();
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  writeFileSync(join(DIST_DIR, "manifest.json"), manifestBytes);
  writeFileSync(join(DIST_DIR, "manifest.sig"), Buffer.from(slh_dsa_sha2_256f.sign(manifestBytes, secretKey)));

  if (generated) {
    adminCreds.slhdsa_256f_priv_key = Buffer.from(secretKey).toString("base64");
    writeFileSync(adminCredsPath, JSON.stringify(adminCreds, null, 2) + "\n", "utf8");
  }

  const publicKeyB64 = Buffer.from(publicKey).toString("base64");
  const bundleCode = await bundleVerifier(assetBaseUrl, publicKeyB64);
  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(LOCAL_INDEX_PATH, buildLocalIndexHtml(bundleCode), "utf8");

  const keyNote = generated ? ` (generated a new keypair, written back to ${adminCredsPath})` : "";
  console.log(`Signed ${Object.keys(manifest).length} asset(s) with SLH-DSA-SHA2-256f${keyNote}.`);
  console.log(`Wrote ${relative(resolve(UI_DIR, ".."), LOCAL_INDEX_PATH)}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
