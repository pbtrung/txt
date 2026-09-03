# txt

`txt` is a single-owner encrypted EPUB library. One Cloudflare Worker serves
both the API (`/v1/*`) and the static React UI, backed by D1 and R2, gated by
Cloudflare Access. There is exactly one authenticated owner. There are no
registrations, invitations, roles, or account-management screens.

The owner can create public read-only links. A recipient does not become an
account: the link is a bearer capability that lets the recipient request a
short-lived, exact-object R2 URL and decrypt that shared copy in the browser.

See [authentication](docs/auth.md), [data model](docs/data_model.md),
[storage layout](docs/storage_layout.md), [sharing](docs/sharing.md),
[cryptography](docs/crypto.md), [deployment](docs/deployment.md), and the
[implementation plan](docs/milestones.md) for the complete design. The design
is decided; implementation is in progress per `docs/milestones.md`. The
Python CLI's `--init-owner` and `--ingest`, and the browser UI, target the
Cloudflare/D1 design described here; `--update-db`, `--clean-bucket`, and
`--clean-db` still target the design's predecessor (rqlite) and aren't
reachable from the CLI until they're rewritten.

## Architecture

```text
Browser ── HTTPS ─┬─> Worker /v1/* (Access-gated, except /v1/shared-url) ─┬─> D1
                  │                                                       └─> R2 (credential minting only)
                  └─> Worker static assets (dist/, ungated)
                  └─> Cloudflare R2 encrypted objects (direct, via minted credentials)
```

- Cloudflare Access authenticates the owner at the edge; the Worker accepts
  only the configured `OWNER_EMAIL`.
- The owner's library — catalog metadata, reading state, bookmarks, and share
  grants — lives in D1, row-by-row encrypted.
- Every EPUB is a separate immutable encrypted R2 object.
- The browser performs EPUB encryption and decryption. The Worker never
  receives plaintext books or share content keys.
- Every D1-mutating endpoint and R2 credential minting require proof of
  possession of the owner's P-521 signing key, on top of the Access session.
- Shared EPUB downloads go directly from R2 to the recipient through a
  short-lived presigned URL; EPUB bytes do not pass through the Worker.

## Main features

- One in-memory unlocked owner session, backed by D1 through the Worker
  rather than a locally opened database file.
- Searchable catalog metadata, reading position, CFI bookmarks, and responsive
  EPUB rendering.
- P-521 proof of possession on every mutation and before the Worker signs
  temporary owner R2 access.
- Exact-path and prefix-scoped R2 authorization with optimistic-concurrency
  reading-state updates.
- Owner-created, independently encrypted, revocable public shares.
- Direct R2 downloads through 60-second exact-object presigned URLs.
- D1's built-in point-in-time recovery for the database; R2 retention/
  versioning for object durability.

## Install

Requires Python 3.14 or newer and Node.js 22.13 or newer.

```sh
pip install -e ".[dev]"
npm install
```

## Owner provisioning

`creds.json` holds the owner's Cloudflare credentials and R2 access. Leave
`user_root_key` empty on the first run; `--init-owner` generates a 256-byte
base64 key and writes it back to the file:

```json
{
  "owner_email": "owner@example.com",
  "cf_account_id": "...",
  "cf_d1_database_id": "...",
  "cf_d1_api_token": "...",
  "display_name": "Owner",
  "r2_config": {
    "endpoint": "https://<account_id>.r2.cloudflarestorage.com",
    "read_write_access_key_id": "...",
    "read_write_secret_access_key": "...",
    "region": "auto",
    "bucket": "..."
  },
  "user_root_key": ""
}
```

`owner_email` must exactly match the Worker's configured `OWNER_EMAIL`
(`docs/deployment.md`). `cf_d1_api_token` is a Cloudflare API token with D1
edit permission for `cf_d1_database_id` — separate from the Worker's own
`R2_PARENT_SECRET_ACCESS_KEY`/`TICKET_SIGNING_KEY`/`SHARE_GRANT_KEY` secrets, and
never shared with the Worker. Provisioning is a one-time, idempotent
operation: a second run against an already-provisioned database validates
the existing owner row instead of creating a second one, and a mismatched
`owner_email` or `user_root_key` is rejected rather than silently proceeding.

```sh
txt --init-owner creds.json --verbose
```

## Browser unlock file

Unlock the deployed UI with a separate owner-only JSON file containing exactly
the browser's own secret:

```json
{
  "user_root_key": "<generated padded base64>"
}
```

Cloudflare Access supplies the identity check on login; this file only needs
to carry the one secret nothing else can derive (`docs/auth.md` §3). The UI
retains the selected file's credentials and all decrypted material only in
page memory; lock or reload before leaving the device. Do not commit or
upload this file.

## Ingesting EPUBs

Uploads each new `*.epub` in a directory as an encrypted R2 object and writes
its rows directly to D1 (`docs/data_model.md`). `--local-db-dir` holds a
small local recovery checkpoint, not a database file — R2 and D1 are always
the source of truth:

```sh
txt --ingest ./books --local-db-dir ./data --creds creds.json --verbose
```

Prepare EPUBs or replace their images:

```sh
txt --edit-epub ./source ./edited --verbose
txt --replace-images ./source ./without-images
```

**Not yet available** ([`docs/milestones.md`](docs/milestones.md)
Milestone 9): migrating the catalog/reading-state schema (`--update-db`) and
cleaning up unreferenced R2 objects or stale share rows (`--clean-bucket`,
`--clean-db`) still target the design's predecessor (rqlite) internally and
aren't currently reachable from the CLI, pending their own rewrite for D1.

## Migrating from the predecessor (rqlite) design

Imports one owner's rqlite-hosted `owner_control` row and whole R2-hosted
SQLCipher database (docs and code on the `master` branch) into a
provisioned D1 owner, re-encrypting every EPUB, its reading state, and its
bookmarks under the D1 owner's own keys. The rqlite/SQLCipher source is
only ever read, never written. `RQL_CREDS_JSON` holds the source owner's
`rqlite_admin_username`/`rqlite_admin_password`/`rqlite_operator_url`,
`firebase_email`/`firebase_password`/`firebase_api_key`, `user_root_key`,
and `r2_config` for the source R2 bucket; `CF_CREDS_JSON` is the
destination owner's usual `creds.json` (already provisioned via
`--init-owner`). `--local-db-dir` holds a local copy of the downloaded
SQLCipher database (for inspection only) and the recovery checkpoint:

```sh
txt --migrate-rql rql_creds.json creds.json --local-db-dir ./data --verbose
```

`--limit N` migrates at most `N` not-yet-migrated documents (oldest first)
in one run — useful for a small test batch before migrating the rest:

```sh
txt --migrate-rql rql_creds.json creds.json --local-db-dir ./data --limit 10 --verbose
```

A run interrupted between a document's insert and its bookmarks resumes
from the checkpoint without re-uploading or re-inserting the document; a
document already fully migrated is skipped on the next run except for a
cheap catalog reconciliation. Active public shares (`txt_shares`) are not
migrated by this command — an existing share URL's capability and content
key would need to keep working unchanged, which is a materially different
problem from re-encrypting a document.

## Development checks

```sh
pytest
python3 -m ruff check .
python3 -m ruff format --check .
npm run ui:test
npm run ui:typecheck
npm run lint
npm run format:check
npm run ui:build
```

Deployment configuration and release verification are specified in
[docs/deployment.md](docs/deployment.md).
