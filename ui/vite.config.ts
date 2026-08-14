/// <reference types="vitest/config" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export default defineConfig({
  // Explicit, not left to default to process.cwd(): there's a single
  // package.json at the repo root (no ui/package.json, no npm workspaces),
  // so root scripts invoke vite/vitest with `--config ui/vite.config.ts`
  // from the repo root, not from inside ui/ itself.
  root: UI_DIR,
  plugins: [react()],
  // sqlcipher/ is served as-is at the site root (/sqlcipher.js,
  // /sqlcipher.wasm) so the browser loader can fetch it directly. The other
  // files living there (test scripts, the .symbols list) get copied along
  // too -- harmless build noise, not worth a custom copy step to exclude.
  publicDir: SQLCIPHER_DIR,
  define: {
    __SQLCIPHER_JS_INTEGRITY__: JSON.stringify(sqlcipherJsIntegrity()),
  },
  build: {
    outDir: DIST_DIR,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // A prior version of this app was crashed by exactly this: a
        // cross-chunk dynamic import resolved via a relative specifier
        // that only worked when the entry chunk had a stable src URL --
        // it didn't when mounted as an inline, no-src module script,
        // causing the module registry to load and mount a second copy of
        // the whole app on top of the first ("Failed to execute
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
  },
});
