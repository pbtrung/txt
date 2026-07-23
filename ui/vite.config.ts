/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// ui/leancrypto/ already holds the prebuilt leancrypto.js/.wasm pair (see
// docs/ui.md / CLAUDE.md) -- pointing publicDir at it directly serves both
// files at /leancrypto.js and /leancrypto.wasm with no copying or build step.
export default defineConfig({
  plugins: [vue()],
  publicDir: "leancrypto",
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
        // fires, the browser can't recognize the entry as already loaded,
        // fetches + executes a second, independent copy of the whole app
        // from the CDN, and mounts it on top of the first ("[Vue warn]:
        // There is already an app instance mounted on the host
        // container."), corrupting both instances' DOM tracking -- this is
        // the real cause of the "Failed to execute 'removeChild'"/
        // "Cannot read properties of null (reading 'nextSibling')" crashes
        // chased at length in CLAUDE.md's project history (confirmed
        // identical in both the React and Vue versions, since both mount
        // the entry the same inline way). inlineDynamicImports merges that
        // dynamic import into the entry chunk instead of splitting it out,
        // so there's no cross-chunk relative import left to resolve
        // incorrectly, regardless of how the entry is loaded.
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
