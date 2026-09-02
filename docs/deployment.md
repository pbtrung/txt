# Deployment — Design

The whole application runs as one Cloudflare Worker under one Cloudflare
account: the API, the static UI, the database, and object storage are
Workers, D1, and R2. There is no separate container, gateway process, or
persistent volume to provision.

## 1. Cloudflare resources

- **Worker**: one Worker serving both `/v1/*` (API route handlers) and
  every other path (the static UI, via a static assets binding pointing
  at `dist/`, `not_found_handling: "single-page-application"`).
- **D1**: one database (`docs/data_model.md`), bound to the Worker.
- **R2**: the application bucket (`docs/storage_layout.md`), bound to
  the Worker for minting scoped credentials only — the Worker never
  proxies object bytes.
- **Access**: one Cloudflare Access application in front of `/v1/*` on
  the deployed host, policy `Include: emails equals OWNER_EMAIL`
  (`docs/auth.md` §2).
- **WAF rate-limiting rule**: one rule covering `/v1/*`, configured
  directly in the dashboard (`docs/auth.md` §6).

## 2. Configuration

Non-secret, deployment-specific `vars` (`docs/auth.md` §2):

```text
OWNER_EMAIL
CF_ACCESS_TEAM_DOMAIN
CF_ACCESS_AUD
```

`OWNER_EMAIL`, `CF_ACCESS_AUD`, and `CF_ACCESS_TEAM_DOMAIN` (used to build
both the JWKS URL and the expected `iss`) back the Worker's independent
verification of the Access JWT. `wrangler.jsonc` never commits their real
values — only `replace-me-*` placeholders the Worker's own `requireVar()`
check deliberately refuses to run with. `scripts/deploy.sh` requires all
three (alongside `BUCKET_NAME`, `docs/storage_layout.md`) as environment
variables and substitutes them into a throwaway config copy before calling
`wrangler deploy`; running `npm run deploy` without one set fails fast with
a clear error instead of deploying a broken or placeholder configuration.

Secrets, set once per deployment with `wrangler secret put <NAME>` (never
committed, never passed through `scripts/deploy.sh`):

```text
SHARE_GRANT_KEY
```

`SHARE_GRANT_KEY` is an independent 32-byte secret (`openssl rand -base64
32`) used only to encrypt/decrypt share-object-path grants (`docs/crypto.md`
§"Share grant envelope", `docs/sharing.md`).

Plus the D1 binding (`DB`) and R2 bucket binding declared in
`wrangler.jsonc`. Cloudflare terminates TLS and
runs Access at its own edge; there is no gateway TLS certificate or origin
CA bundle to manage.

## 3. Owner initialization

Provisioning creates the singleton `owner` row (`docs/data_model.md` §2):
a fresh `user_root_key`, `umk`, composite KEM keypair, P-521 signing
keypair, `db_prefix`, and the initial encrypted credential payload.
Re-running provisioning validates the existing row rather than replacing
it; a different `OWNER_EMAIL` is rejected. There is no owner list,
invitation, or delegated-access workflow — recovery requires the owner's
credential file, `user_root_key`, and the R2 objects.

The browser's local unlock file contains:

```json
{
  "user_root_key": "<padded standard base64>"
}
```

Cloudflare Access login itself supplies the identity check; the unlock
file only needs to carry the one secret nothing else can derive.

## 4. R2

Configure bucket CORS for the exact deployed UI origin
(`docs/storage_layout.md` §"Path and access rules"). Shared EPUBs are
downloaded directly from R2 through 60-second exact-object presigned
URLs (`docs/sharing.md`); the Worker must not fetch or stream their
response bodies.

## 5. Static UI

Build the React UI and deploy it as part of the Worker:

```sh
npm run ui:build
wrangler deploy
```

`wrangler.jsonc` declares the Worker's entry point, its D1 and R2
bindings, and `dist/` as its static assets directory with
`not_found_handling: "single-page-application"`. The static CSP permits
HTTPS connections to the deployed host; EPUB scripts remain disabled and
EPUB resource directives remain restricted. The shared route (`/shared`)
is public; owner library routes require an Access session and the
unlocked local vault (`docs/auth.md`).

The URL fragment containing a share capability and content key must
never be forwarded to analytics, error reporting, or server logs.

## 6. Backups

D1 has built-in point-in-time recovery ("Time Travel"). Confirm the
retention window included on the account's plan; it is the primary
recovery mechanism for the database. For R2 object durability, use R2's
own retention/versioning when multiple dated restore points are needed
for document or shared-copy objects.

## 7. Release verification

Before exposing a deployment, verify:

1. `/v1/*` is unreachable without a valid Access session, except `POST
/v1/shared-url`.
2. Static assets, including the shared-reading page's own JS/CSS, load
   without any Access session.
3. Owner login through Access, ticket issuance, proof-of-possession
   signing, and 15-minute R2 credentials all work end to end
   (`docs/auth.md` §5).
4. A deliberate concurrent reading-state write produces a `412` and the
   client's retry recovers cleanly (`docs/data_model.md` §4).
5. Document upload, download, reading position, and bookmarks persist.
6. Share creation uploads one independently encrypted R2 object and
   registers one `active` `shares` row; anonymous redemption returns a
   60-second URL for only that object (`docs/sharing.md`).
7. An invalid capability, expired presigned URL, malformed request, and
   exceeded rate limit each fail with the expected status.
8. Revocation blocks new URLs immediately, deletes the R2 object, and
   removes the `shares` row (and its `key_store` row) after deletion
   succeeds.
9. A redeploy preserves owner, document, bookmark, and share state (D1
   and R2 are unaffected by a Worker redeploy).

## 8. Free-tier budget

Confirm current figures against the Cloudflare dashboard before
deploying — free-tier allowances change — but at design time:

| Resource                 | Free allowance                       | Fit for a single-owner app                                                                                                                                             |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers requests         | 100,000 / day                        | Comfortable; one owner plus occasional anonymous share reads                                                                                                           |
| Workers CPU time         | 10 ms / invocation                   | JWT/HMAC/P-521 verification and small D1 queries are well under this; profile the mutating-endpoint class specifically, since every one of them verifies a P-521 proof |
| D1 storage               | 5 GB                                 | Metadata and wrapped keys only — content stays in R2                                                                                                                   |
| D1 rows read             | 5,000,000 / day                      | Comfortable at personal-library scale                                                                                                                                  |
| D1 rows written          | 100,000 / day                        | Comfortable even with `key_store`'s extra write per new row (two for a new `documents` row)                                                                            |
| D1 free-tier enforcement | Hard failure once a daily cap is hit | No headroom for a runaway loop — the rate-limiting rule bounds this                                                                                                    |
| Workers static assets    | 20,000 files                         | Far more than this UI's build output                                                                                                                                   |
| Cloudflare Access seats  | 50 users                             | One owner uses one seat                                                                                                                                                |
| WAF rate-limiting rules  | 1 custom rule                        | Allocated in `docs/auth.md` §6                                                                                                                                         |
