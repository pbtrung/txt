/// <reference types="vitest/config" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const UI_DIR = dirname(fileURLToPath(import.meta.url));

// ui/leancrypto/ already holds the prebuilt leancrypto.js/.wasm pair (see
// docs/ui.md / CLAUDE.md) -- pointing publicDir at it directly serves both
// files at /leancrypto.js and /leancrypto.wasm with no copying or build step.

// leancrypto.js is loaded via a dynamically-created <script src="/leancrypto.js">
// (crypto/leancryptoLoader.ts), not a <script type=module>/<link> tag in
// index.html -- so it never goes through build-integrity.mjs's addSri(),
// which only tags those. Its SHA-512 is computed here at config-load time
// and baked into the app bundle via `define`, the same technique
// build-integrity.mjs uses to bake the SLH-DSA public key into the
// local_index.html verifier bundle -- leancryptoLoader.ts sets it as that
// script element's `integrity` before ever assigning `src`.
function leancryptoJsIntegrity(): string {
  const bytes = readFileSync(join(UI_DIR, "leancrypto", "leancrypto.js"));
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export default defineConfig({
  plugins: [react()],
  publicDir: "leancrypto",
  define: {
    __LEANCRYPTO_JS_INTEGRITY__: JSON.stringify(leancryptoJsIntegrity()),
  },
  build: {
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
        inlineDynamicImports: true,
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
