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
//   3. Writes dist/_headers (Cloudflare Pages' own response-header config
//      file -- see docker/README.md; ui/ deploys there, not from docker/,
//      which is rqlite/OpenResty only). Narrows the direct-CDN-visit CSP's
//      connect-src from index.html's own <meta> tag's deliberately-open '*'
//      down to 'self' plus this deployment's own rqlite/OpenResty endpoint
//      (--build-creds's rqlite_url) and R2's host pattern; sets
//      Access-Control-Allow-Origin: null (the literal string, not a
//      wildcard) so local_index.html -- opened via file://, which sends
//      Origin: null on its cross-origin fetches -- can actually read the
//      response bodies of its fetches to manifest.json/manifest.sig/every
//      other dist/ asset; a wildcard '*' doesn't reliably do this in
//      practice for a null-origin request the way it does for a real
//      origin (confirmed the hard way -- see git history). Safe to allow
//      broadly: these are public, non-secret build outputs whose integrity
//      local_index.html itself checks via SLH-DSA/SHA-512, not via keeping
//      them cross-origin-unreadable; and
//      sets Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy, which
//      is what makes SharedArrayBuffer available at all for
//      data/dbWorker.ts's Worker+Atomics bridge -- there's no separate
//      server config to set these on Cloudflare Pages, only this file. A
//      deploy-time config file, never itself served as a fetchable path,
//      so it's written after buildManifest() runs, not before -- same
//      reason manifest.json/manifest.sig are, below.
//   4. Loads (or, only if absent, generates) an SLH-DSA-SHA2-256f keypair
//      (@noble/post-quantum) from --build-creds's slhdsa_256f_priv_key,
//      signs manifest.json's literal bytes with it, and writes the raw
//      signature to dist/manifest.sig. A freshly generated secret key gets
//      written back into that same build-creds file (nothing else in it is
//      touched) -- an existing key is always reused so a rebuild doesn't
//      silently invalidate every local_index.html copy already in the wild.
//   5. Bundles ui/src/localIndex/main.ts (via Vite's own build API, iife
//      format, so @noble/post-quantum and its own dependencies get inlined
//      into one self-contained script -- no CDN/npm fetch at verify-time)
//      with the derived public key and --build-creds's asset_base_url baked
//      in, plus dist/index.html's own <title>/favicon (so the browser tab
//      looks the same throughout the whole verify-then-render lifecycle,
//      not just after the real app mounts), and writes the result to
//      creds/local_index.html -- never dist/, so it's never uploaded to
//      the CDN. This is the file a user opens (over the same
//      cross-origin-isolated Cloudflare Pages deployment, not bare
//      file:///content://, per docker/README.md) to verify everything
//      before the real app ever renders; see ui/src/localIndex/ for that
//      verification logic and why it can't live inside dist/ itself.
//
// build-creds.json (gitignored, ui/build-creds.json by default) is a small,
// operator-owned deployment config -- asset_base_url/rqlite_url/
// slhdsa_256f_priv_key are all build-time secrets/facts about *this
// deployment*, unrelated to any individual end user's own vault creds (see
// data/creds.ts) -- so it gets its own file rather than reusing the old
// admin_creds.json shape from the Turso-backed design. rqlite_url mirrors
// data/creds.ts's own field name for the same concept (a Creds.rqlite_url
// value one operator account would plausibly already have on hand), even
// though this is a separate, deployment-level fact, not an end user's own
// vault credential.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { slh_dsa_sha2_256f } from "@noble/post-quantum/slh-dsa.js";
import { build } from "vite";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(UI_DIR, "..");
// vite.config.ts builds to <repo root>/dist, not ui/dist -- see its own
// comment on build.outDir for why.
const DIST_DIR = join(REPO_ROOT, "dist");
const INDEX_HTML_PATH = join(DIST_DIR, "index.html");
const CREDS_DIR = join(REPO_ROOT, "creds");
const LOCAL_INDEX_PATH = join(CREDS_DIR, "local_index.html");
const VERIFIER_ENTRY = join(UI_DIR, "src", "localIndex", "main.ts");
const DEFAULT_BUILD_CREDS_PATH = join(UI_DIR, "build-creds.json");

// Accepts either --build-creds <path>/--build-creds=<path>, or a bare
// positional path (e.g. `npm run ui:build -- path/to/creds.json`) -- the
// first non-flag argument, so the common case doesn't need the flag name
// spelled out. Falls back to ui/build-creds.json if neither is given.
function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--build-creds") return { buildCredsPath: argv[i + 1] };
    if (arg.startsWith("--build-creds="))
      return { buildCredsPath: arg.slice("--build-creds=".length) };
  }
  const positional = argv.find((arg) => !arg.startsWith("--"));
  return { buildCredsPath: positional ?? DEFAULT_BUILD_CREDS_PATH };
}

function loadBuildCreds(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to read/parse --build-creds file ${path}: ${err.message}`);
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
      throw new Error(
        `tag already has an integrity attribute -- run this script only once per build: ${tag}`,
      );
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
// every other directive is what it is -- script-src's blob: matters
// especially here: this is a real HTTP response header, unlike the meta
// tag, so it's the one that actually gets inherited by data/dbWorker.ts's
// Worker, where data/wasmLoader.ts's blob-URL import() of sqlcipher.js runs)
// except connect-src, narrowed here from that meta tag's deliberately-open
// '*' down to 'self' plus the two host patterns the app actually talks to:
// this deployment's own rqlite/OpenResty endpoint (a single,
// operator-controlled host, unlike the old Turso-backed design where every
// customer had their own database URL -- hence baking in the real host here
// instead of a wildcard) and R2's standard custom-domain pattern. A real
// HTTP response header and a <meta> CSP both apply at once and combine by
// intersection, so this tightens the effective policy for a direct CDN
// visit without having to touch the per-account-agnostic meta tag itself.
function distCsp(rqliteUrl) {
  return (
    "default-src 'self'; " +
    "script-src 'self' 'wasm-unsafe-eval' blob:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self' data:; " +
    `connect-src 'self' ${new URL(rqliteUrl).origin} https://*.r2.cloudflarestorage.com; ` +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self';"
  );
}

// See this file's own header comment for what each header is for.
// `credentialless` (not the stricter `require-corp`) for COEP: `require-corp`
// would also block the app's own cross-origin fetches to the rqlite API and
// to R2, since neither service necessarily sends back a
// Cross-Origin-Resource-Policy header of its own.
function writeHeadersFile(rqliteUrl) {
  const headers =
    `/*\n` +
    `  Content-Security-Policy: ${distCsp(rqliteUrl)}\n` +
    `  Access-Control-Allow-Origin: null\n` +
    `  Cross-Origin-Opener-Policy: same-origin\n` +
    `  Cross-Origin-Embedder-Policy: credentialless\n`;
  writeFileSync(join(DIST_DIR, "_headers"), headers, "utf8");
}

/** Reuses slhdsa_256f_priv_key from buildCreds if it's a non-empty base64
 * string; otherwise generates a fresh keypair. Never regenerates when a key
 * is already present. */
function loadOrCreateKeypair(buildCreds) {
  const raw = buildCreds.slhdsa_256f_priv_key;
  if (typeof raw === "string" && raw.length > 0) {
    const secretKey = Buffer.from(raw, "base64");
    return { secretKey, publicKey: slh_dsa_sha2_256f.getPublicKey(secretKey), generated: false };
  }
  const { secretKey, publicKey } = slh_dsa_sha2_256f.keygen();
  return { secretKey, publicKey, generated: true };
}

function requireStringField(buildCreds, buildCredsPath, field) {
  const value = buildCreds[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${buildCredsPath} has no ${field} field`);
  }
  return value;
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

/** Reads dist/index.html's own <title> and <link rel="icon"> so the browser
 * tab looks the same throughout local_index.html's whole verify-then-render
 * lifecycle, not just after the real app mounts -- derived from index.html
 * itself rather than hardcoded, so a future title/favicon change there
 * doesn't also need a matching edit here. The favicon gets inlined as a
 * data: URI (self-contained, no separate fetch needed before it's even
 * possible to trust asset_base_url) rather than referencing its dist/ path. */
function extractTabIdentity(html) {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "Verifying…";
  const iconTag = /<link([^>]*\srel="icon"[^>]*)>/i.exec(html)?.[1];
  const iconHref = iconTag && /\shref="([^"]+)"/.exec(iconTag)?.[1];
  const iconType = (iconTag && /\stype="([^"]+)"/.exec(iconTag)?.[1]) ?? "image/svg+xml";
  if (!iconHref) return { title, faviconDataUri: null };
  try {
    const bytes = readFileSync(join(DIST_DIR, iconHref.replace(/^\//, "")));
    return { title, faviconDataUri: `data:${iconType};base64,${bytes.toString("base64")}` };
  } catch {
    return { title, faviconDataUri: null };
  }
}

function buildLocalIndexHtml(bundleCode, title, faviconDataUri) {
  // Escaping </script -- same reason as the old sign-assets.mjs's JSON
  // injection: bundleCode is untrusted-shape text (could in principle
  // contain a string literal with that sequence) that must not be able to
  // close the surrounding <script> tag early.
  const safeCode = bundleCode.replace(/<\/script/gi, "<\\/script");
  const faviconTag = faviconDataUri ? `\n    <link rel="icon" href="${faviconDataUri}" />` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />${faviconTag}
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script>${safeCode}</script>
  </body>
</html>
`;
}

async function main() {
  const { buildCredsPath } = parseArgs(process.argv.slice(2));
  const buildCreds = loadBuildCreds(buildCredsPath);
  const assetBaseUrl = requireStringField(buildCreds, buildCredsPath, "asset_base_url");
  const rqliteUrl = requireStringField(buildCreds, buildCredsPath, "rqlite_url");
  const { secretKey, publicKey, generated } = loadOrCreateKeypair(buildCreds);

  const originalHtml = readFileSync(INDEX_HTML_PATH, "utf8");
  writeFileSync(INDEX_HTML_PATH, addSri(originalHtml), "utf8");

  const manifest = buildManifest();
  writeHeadersFile(rqliteUrl);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  writeFileSync(join(DIST_DIR, "manifest.json"), manifestBytes);
  writeFileSync(
    join(DIST_DIR, "manifest.sig"),
    Buffer.from(slh_dsa_sha2_256f.sign(manifestBytes, secretKey)),
  );

  if (generated) {
    buildCreds.slhdsa_256f_priv_key = Buffer.from(secretKey).toString("base64");
    writeFileSync(buildCredsPath, JSON.stringify(buildCreds, null, 2) + "\n", "utf8");
  }

  const publicKeyB64 = Buffer.from(publicKey).toString("base64");
  const bundleCode = await bundleVerifier(assetBaseUrl, publicKeyB64);
  const { title, faviconDataUri } = extractTabIdentity(originalHtml);
  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(LOCAL_INDEX_PATH, buildLocalIndexHtml(bundleCode, title, faviconDataUri), "utf8");

  const keyNote = generated ? ` (generated a new keypair, written back to ${buildCredsPath})` : "";
  console.log(`Signed ${Object.keys(manifest).length} asset(s) with SLH-DSA-SHA2-256f${keyNote}.`);
  console.log(`Wrote ${relative(REPO_ROOT, LOCAL_INDEX_PATH)}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
