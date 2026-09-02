// Applies migrations/*.sql (read by vitest.config.ts, passed through as the
// TEST_MIGRATIONS binding) to the per-run local D1 instance before any test
// runs, so every test file sees the real schema -- not a hand-rolled subset
// of it -- including every trigger docs/data_model.md §2 depends on.
import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// `env`'s type (`Cloudflare.Env`, declared in
// worker/worker-configuration.d.ts) doesn't know about TEST_MIGRATIONS --
// it's a miniflare-only test binding (worker/vitest.config.ts), not a real
// wrangler.jsonc binding `wrangler types` could see.
declare global {
  // `namespace` is the only way to merge into `Cloudflare.Env`, the ambient
  // interface `wrangler types` itself declares this way -- an ES module
  // can't add members to an existing namespace's interface any other way.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
