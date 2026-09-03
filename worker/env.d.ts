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
    // locally-signed temporary credentials: R2_PARENT_ACCESS_KEY_ID is
    // that token's access key id (reused as-is for every minted
    // credential and embedded as the signed JWT's issuer),
    // R2_PARENT_SECRET_ACCESS_KEY is the same token's secret access key
    // (the HMAC key every scoped JWT is signed with -- R2 verifies with
    // its own copy, never sent anywhere).
    R2_PARENT_ACCESS_KEY_ID: string;
    R2_PARENT_SECRET_ACCESS_KEY: string;
    // docs/crypto.md §"Share grant envelope".
    SHARE_GRANT_KEY: string;
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TICKET_SIGNING_KEY: string;
      R2_PARENT_ACCESS_KEY_ID: string;
      R2_PARENT_SECRET_ACCESS_KEY: string;
      SHARE_GRANT_KEY: string;
    }
  }
}
