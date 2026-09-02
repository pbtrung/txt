import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const WORKER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(WORKER_DIR, "..");

// Read once at config-eval time (Node context, not the worker runtime) and
// handed to the worker via a JSON-serializable binding below; applied inside
// worker/testSetup.ts through `applyD1Migrations`, which is only callable
// from within the worker runtime itself.
const migrations = await readD1Migrations(join(WORKER_DIR, "migrations"));

export default defineConfig({
  test: {
    include: ["worker/tests/**/*.test.ts"],
    setupFiles: ["./worker/testSetup.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: join(REPO_ROOT, "wrangler.jsonc") },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Override wrangler.jsonc's committed "replace-me-*" placeholders
          // (which worker/api.ts's requireVar() deliberately rejects, since
          // seeing one for real would mean a deploy forgot to substitute it)
          // with fixed, realistic test values.
          OWNER_EMAIL: "owner@example.com",
          CF_ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
          CF_ACCESS_AUD: "test-access-application-aud",
        },
      },
    }),
  ],
});
