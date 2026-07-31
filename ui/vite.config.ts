/// <reference types="vitest/config" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(UI_DIR, "..");
const SQLCIPHER_DIR = join(REPO_ROOT, "sqlcipher");
// Built at the repo root (../dist from here), not ui/dist -- kept out of
// ui/ itself so it never looks like a source directory. Absolute, not
// relative to `root` (Vite's own default for build.outDir): Vite resolves
// a relative outDir against `root`, which would put it back under ui/.
const DIST_DIR = join(REPO_ROOT, "dist");

// The repo-root sqlcipher/ bundle (see CLAUDE.md) already covers everything
// ui/leancrypto/ used to vendor separately -- the same lc_wasm_* HKDF/AEAD
// primitives crypto/blob.ts needs, plus real SQLCipher access, in one
// Emscripten build confirmed to support both Node and browser environments
// (its own glue code branches on ENVIRONMENT_IS_WEB/ENVIRONMENT_IS_WORKER).
// publicDir serves it verbatim at build time; only sqlcipher.js/.wasm are
// actually needed in dist/ -- everything else in that directory (the Node
// .d.ts, package.json, the js-vfs.mjs full-preload VFS this project's own
// lazy remoteVfs.ts doesn't use, its symbols/test files) is removed from
// dist/ by the build script's post-`vite build` cleanup step.

// sqlcipher.js is loaded via data/wasmLoader.ts's own fetch()+verify+
// blob-import (needed so the exact same loading code works identically on
// the main thread and inside dbWorker.ts's Worker, which has no <script>/
// <link> tags to hang SRI off of) -- not a <script type=module>/<link> tag
// in index.html, so it never goes through build-integrity.mjs's addSri(),
// which only tags those. Its SHA-512 is computed here at config-load time
// and baked into the app bundle via `define` (applied to every build Vite
// produces from this config, including Worker bundles, not just the main
// entry) -- the same technique build-integrity.mjs uses to bake the SLH-DSA
// public key into the local_index.html verifier bundle. wasmLoader.ts
// compares a freshly computed digest of the fetched bytes against this
// value before ever executing them.
function sqlcipherJsIntegrity(): string {
  const bytes = readFileSync(join(SQLCIPHER_DIR, "sqlcipher.js"));
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export default defineConfig({
  // Explicit, not left to default to process.cwd(): there's a single
  // package.json at the repo root now (no ui/package.json, no npm
  // workspaces), so root scripts invoke vite/vitest with
  // `--config ui/vite.config.ts` from the repo root, not from inside ui/
  // itself. Vite's own default for `root` is process.cwd() (not "wherever
  // this config file lives"), so without this, index.html/src resolution
  // would silently look in the wrong directory whenever a script runs from
  // the repo root instead of ui/.
  root: UI_DIR,
  plugins: [react()],
  publicDir: SQLCIPHER_DIR,
  define: {
    __SQLCIPHER_JS_INTEGRITY__: JSON.stringify(sqlcipherJsIntegrity()),
  },
  // remotePageClient.ts's Worker+Atomics bridge needs SharedArrayBuffer,
  // which browsers only expose to a cross-origin-isolated page (COOP/COEP
  // response headers -- see docker/README.md's local_index.html hosting
  // notes). build-integrity.mjs bakes the same pair into dist/_headers for
  // the real Cloudflare Pages deployment; without this, `vite dev`/`vite
  // preview` never send them at all and unlock() fails with "SharedArrayBuffer
  // is not defined" the moment dbWorker.ts's open() spawns the page worker.
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  build: {
    outDir: DIST_DIR,
    // outDir resolves outside `root` (repo root vs. ui/) -- Vite's own
    // safety check refuses to empty a directory it doesn't consider
    // "inside" the project without this.
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Without this, crypto/brotli.ts's `import("brotli-wasm")` (needed
        // to pick the browser build over the Node one -- see that file's
        // own comment) gets split into its own chunk, which Rollup then
        // has that chunk import a small shared helper *back* from the
        // entry chunk via a literal relative specifier
        // (`import ... from "./index-<hash>.js"`). That's harmless for a
        // normal page load, where the entry has a real `src` URL the
        // browser's module registry can key by -- but local_index.html
        // (ui/src/localIndex/render.ts) mounts the entry as an inline
        // `<script type="module">` with no `src` at all, so it has no
        // stable URL there. The first time that dynamic import actually
        // fires (which happens exactly when unlock() first needs to
        // decompress a blob), the browser can't recognize the entry as
        // already loaded, fetches + executes a second, independent copy of
        // the whole app from the CDN, and mounts it on top of the first
        // (React logs "Warning: You are calling ReactDOM.createRoot() on a
        // container that has already been passed to createRoot() before"),
        // corrupting both instances' fiber trees -- this is the real cause
        // of the "Failed to execute 'removeChild'" crashes chased at
        // length in this project's history (confirmed identical in a
        // parallel Vue port of this same app, since both mount the entry
        // the same inline way -- diagnosed there first by rebuilding with
        // NODE_ENV forced to development so Vue's own dev warnings
        // ("There is already an app instance mounted on the host
        // container") surfaced the double mount directly). inlineDynamicImports
        // merges that dynamic import into the entry chunk instead of
        // splitting it out, so there's no cross-chunk relative import left
        // to resolve incorrectly, regardless of how the entry is loaded.
        // This option itself has no unit test -- it only affects Rollup's
        // real `vite build` output, not anything vitest's own (unbundled)
        // module graph goes through -- so it was verified manually: a real
        // build produces exactly one JS file with no relative "./index-..."
        // import left in it, and loading that build's local_index.html via
        // file:// in a real browser mounts cleanly with an empty console.
        // (crypto/brotli.test.ts separately covers that the isBrowser()
        // import("brotli-wasm") branch itself still wires up correctly,
        // which is a different, unit-testable concern from this option.)
        // codeSplitting: false is Rolldown's (Vite's Rust bundler) spelling
        // of the same thing -- it resolves to the identical
        // inlineDynamicImports: true internally, just under the name Vite
        // now emits a deprecation warning for.
        codeSplitting: false,
      },
    },
  },
  test: {
    // Default to "node": crypto/data-layer tests need neither a DOM nor
    // jsdom's fake http://localhost:3000 origin (which brotli-wasm's
    // browser build otherwise tries to `fetch()` its .wasm from). Component
    // tests opt into jsdom per-file via a `// @vitest-environment jsdom`
    // docblock.
    environment: "node",
    setupFiles: ["./src/setupTests.ts"],
    globals: true,
  },
});
