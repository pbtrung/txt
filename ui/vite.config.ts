/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import vue from "@vitejs/plugin-vue";

// ui/leancrypto/ already holds the prebuilt leancrypto.js/.wasm pair (see
// docs/ui.md / CLAUDE.md) -- pointing publicDir at it directly serves both
// files at /leancrypto.js and /leancrypto.wasm with no copying or build step.
//
// react() stays alongside vue() only for the duration of the React->Vue
// migration (see CLAUDE.md) -- it's needed for the .tsx files/tests not yet
// ported, and gets dropped once the last one is.
export default defineConfig({
  plugins: [react(), vue()],
  publicDir: "leancrypto",
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
