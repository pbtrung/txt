// Secrets (`wrangler secret put`, docs/deployment.md §2) never appear in
// wrangler.jsonc, so `wrangler types` can't see them and leaves them off
// the generated `Cloudflare.Env`. This is the one place that gap gets
// closed for real (non-test) code -- worker/testSetup.ts does the same
// merge trick for its own test-only TEST_MIGRATIONS binding.
export {};

declare global {
  // `wrangler types` declares both a bare global `Env` (what application
  // code, e.g. worker/api.ts, actually imports) and `Cloudflare.Env` (what
  // `cloudflare:test`'s `env` export types against) -- both need this
  // merged in.
  interface Env {
    TICKET_SIGNING_KEY: string;
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TICKET_SIGNING_KEY: string;
    }
  }
}
