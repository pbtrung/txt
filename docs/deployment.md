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
  `scripts/deploy.sh` resolves it by name (`txt-production`) on every
  run and creates it (`wrangler d1 create`) if it doesn't exist yet, then
  applies `worker/migrations/` (`wrangler d1 migrations apply --remote`)
  before deploying — a fresh database and an up to date schema are both
  guaranteed on every deploy, not a manual prerequisite.
- **R2**: the application bucket (`docs/storage_layout.md`), bound to the
  Worker for its own direct object operations (e.g. deleting a revoked
  share's object, `docs/sharing.md`) — never for content the browser
  reads or writes. The Worker mints the browser's scoped, temporary
  credentials through a separate mechanism, Cloudflare's account-level R2
  API (`docs/storage_layout.md` §"Credentials"), since the binding itself
  has no method for issuing them. `scripts/deploy.sh` also resolves or
  creates this bucket by name (`wrangler r2 bucket create`) — but not its
  CORS configuration (§4), which still needs the exact deployed UI origin
  set up manually.
- **Access**: one Cloudflare Access application in front of `/v1/*` on
  the deployed host, policy `Include: emails equals OWNER_EMAIL`
  (`docs/auth.md` §2), with a bypass policy for `POST /v1/shared-url`.
  `wrangler` has no command for this at all — configure it manually via
  the dashboard, the same as the WAF rule below.
- **WAF rate-limiting rule**: one rule covering `/v1/*`, configured
  directly in the dashboard (`docs/auth.md` §6).

## 2. Configuration

Non-secret, deployment-specific `vars` (`docs/auth.md` §2):

```text
OWNER_EMAIL
CF_ACCESS_TEAM_DOMAIN
CF_ACCESS_AUD
CF_ACCOUNT_ID
BUCKET_NAME
```

`OWNER_EMAIL`, `CF_ACCESS_AUD`, and `CF_ACCESS_TEAM_DOMAIN` (used to build
both the JWKS URL and the expected `iss`) back the Worker's independent
verification of the Access JWT. `CF_ACCOUNT_ID` and `BUCKET_NAME` back the
R2 temporary-credentials calls (`docs/storage_layout.md` §"Credentials")
— `BUCKET_NAME` here is a plain runtime string the Worker's own code
reads, distinct from the R2 binding's `bucket_name` config field below,
which Worker code can't read at runtime. `wrangler.jsonc` never commits
their real values — only `replace-me-*` placeholders the Worker's own
`requireVar()` check deliberately refuses to run with.

These five values live in a gitignored JSON file (`creds/deploy.json` by
default — `creds/` is already gitignored — or a path passed as
`scripts/deploy.sh`'s first argument for a different deployment):

```json
{
  "BUCKET_NAME": "...",
  "OWNER_EMAIL": "...",
  "CF_ACCESS_TEAM_DOMAIN": "...",
  "CF_ACCESS_AUD": "...",
  "CF_ACCOUNT_ID": "..."
}
```

`scripts/deploy.sh` reads all five from that file and substitutes them
into a throwaway config copy before calling `wrangler deploy`; running
`npm run deploy` with a missing file or a missing/empty key fails fast
with a clear error instead of deploying a broken or placeholder
configuration.

An optional sixth key, `"SKIP_ACCESS_CHECK": true`, deploys with
`worker/api.ts`'s `accessCheckSkipped()` bypass on: every non-public
`/v1/*` route accepts requests with no Access session at all, and
`CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` become optional (unread in that
mode). **Testing only, for exercising the app before an Access
application exists yet — never leave this on for a real deployment.**
`scripts/deploy.sh` prints a loud warning whenever it's on, both before
and after deploying, and it defaults to off: a `creds/deploy.json`
without this key deploys exactly as if it didn't exist.

Secrets, set once per deployment with `wrangler secret put <NAME>` (never
committed, never passed through `scripts/deploy.sh`):

```text
SHARE_GRANT_KEY
TICKET_SIGNING_KEY
R2_PARENT_API_TOKEN
R2_PARENT_ACCESS_KEY_ID
```

`SHARE_GRANT_KEY` is an independent 32-byte secret (`openssl rand -base64
32`) used only to encrypt/decrypt share-object-path grants (`docs/crypto.md`
§"Share grant envelope", `docs/sharing.md`). `TICKET_SIGNING_KEY` is an
independent 32-byte secret (`openssl rand -base64 32`) used only to sign
and verify the owner binding ticket (`docs/auth.md` §4.1).
`R2_PARENT_API_TOKEN` and `R2_PARENT_ACCESS_KEY_ID` are the value and
access key id of one R2 API token, scoped in the dashboard to this bucket
with read-write access — every temporary credential the Worker mints from
it is capped at that same scope (`docs/storage_layout.md`
§"Credentials").

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

The React UI deploys as part of the Worker, via `npm run deploy`
(`scripts/deploy.sh` §2) — not a bare `wrangler deploy`, which would run
against the committed `wrangler.jsonc`'s unsubstituted `replace-me-*`
placeholders directly.

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
10. A `PUT` against `{db_prefix}/catalog/*` using the read-only credential
    from `POST /v1/r2-credentials` is actually rejected by R2 — a scope
    the code only claims to enforce isn't verified until it's tried
    against a real credential (`docs/milestones.md` Milestone 6).

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
