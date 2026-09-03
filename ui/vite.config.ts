/// <reference types="vitest/config" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(UI_DIR, "..");
const DIST_DIR = join(REPO_ROOT, "dist");
const SQLCIPHER_DIR = join(REPO_ROOT, "sqlcipher");

// Baked into ui/src/crypto/sqlcipherLoader.ts's dynamically-injected
// <script> tag as its SRI `integrity` attribute.
function sqlcipherJsIntegrity(): string {
  const bytes = readFileSync(join(SQLCIPHER_DIR, "sqlcipher.js"));
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

// The browser's SRI `integrity` attribute only covers a fetch a <script>
// element itself triggers, not sqlcipher.js's own internal fetch of its
// .wasm binary. sqlcipherLoader.ts fetches sqlcipher.wasm itself and
// checks its digest against this before handing it to the Emscripten
// factory as `wasmBinary`, so a compromise of just the .wasm asset (with
// sqlcipher.js left byte-identical) doesn't go undetected.
function sqlcipherWasmIntegrity(): string {
  const bytes = readFileSync(join(SQLCIPHER_DIR, "sqlcipher.wasm"));
  return createHash("sha512").update(bytes).digest("base64");
}

export default defineConfig({
  // Explicit, not left to default to process.cwd(): there's a single
  // package.json at the repo root (no ui/package.json, no npm workspaces),
  // so root scripts invoke vite/vitest with `--config ui/vite.config.ts`
  // from the repo root, not from inside ui/ itself.
  root: UI_DIR,
  plugins: [tailwindcss(), react()],
  // sqlcipher/ is served as-is at the site root (/sqlcipher.js,
  // /sqlcipher.wasm) so the browser loader can fetch it directly. The other
  // files living there (test scripts, the .symbols list) get copied along
  // too -- harmless build noise, not worth a custom copy step to exclude.
  publicDir: SQLCIPHER_DIR,
  define: {
    __SQLCIPHER_JS_INTEGRITY__: JSON.stringify(sqlcipherJsIntegrity()),
    __SQLCIPHER_WASM_INTEGRITY__: JSON.stringify(sqlcipherWasmIntegrity()),
  },
  build: {
    outDir: DIST_DIR,
    emptyOutDir: true,
    // Single chunk (below) bundles epub.js, brotli-wasm, and the UI runtime,
    // comfortably past Vite's 500 kB default warning -- that default is
    // tuned for apps that code-split, which this one deliberately doesn't.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // A cross-chunk dynamic import resolved via a relative specifier
        // only works when the entry chunk has a stable src URL, which it
        // doesn't when mounted as an inline, no-src module script -- that
        // mismatch causes the module registry to load and mount a second
        // copy of the whole app on top of the first ("Failed to execute
        // 'removeChild'"). Merging everything into one chunk removes the
        // cross-chunk import entirely, regardless of how the entry ends
        // up being loaded.
        codeSplitting: false,
      },
    },
  },
  test: {
    // Default to "node": crypto/data-layer tests need neither a DOM nor a
    // fake browser origin. Component tests opt into jsdom per-file via a
    // `// @vitest-environment jsdom` docblock.
    environment: "node",
    setupFiles: ["./src/setupTests.ts"],
    globals: true,
    alias: {
      // brotli-wasm's package.json "exports" sends any `import` specifier
      // (which is what this ESM app uses, everywhere -- not just tests) to
      // its pure-ESM web build, which does its own async fetch() of the
      // .wasm file -- there's nothing to fetch it from under Vitest, browser
      // or not. index.node.js resolves the same way real Node's own
      // `require()` condition would: synchronously, from disk, no fetch.
      // Both still expose the same `Promise<{ compress, decompress }>`
      // shape brotli.ts awaits, so this doesn't change what the code under
      // test actually does -- only how the wasm gets loaded.
      "brotli-wasm": join(REPO_ROOT, "node_modules/brotli-wasm/index.node.js"),
    },
  },
});
