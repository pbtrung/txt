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
    // The R2 API token backing docs/storage_layout.md §"Credentials"'
    // temp-access-credentials calls: R2_PARENT_API_TOKEN is its raw value
    // (the Bearer auth for that call), R2_PARENT_ACCESS_KEY_ID is the same
    // token's access key id (the request's parentAccessKeyId field).
    R2_PARENT_API_TOKEN: string;
    R2_PARENT_ACCESS_KEY_ID: string;
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TICKET_SIGNING_KEY: string;
      R2_PARENT_API_TOKEN: string;
      R2_PARENT_ACCESS_KEY_ID: string;
    }
  }
}
