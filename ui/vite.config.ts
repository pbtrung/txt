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
