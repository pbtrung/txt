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
is decided; implementation is in progress per `docs/milestones.md` — the
Python CLI and UI referenced below still target the design's predecessor
(rqlite/Firebase/SQLCipher) until each milestone lands.

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

**Pending implementation** ([`docs/milestones.md`](docs/milestones.md)): the
commands below still target the design's predecessor (rqlite/Firebase) and
will not work against a Cloudflare deployment until the Worker, D1 schema,
and CLI rewrite land. They're kept here as a description of the current CLI's
actual behavior, not of `docs/deployment.md`'s design.

Provisioning is a one-time, idempotent operation. `rqlite_operator_url` is
the externally reachable Basic-auth operator route,
for example `https://api.example.com/operator/rqlite`; it is not rqlite's
loopback listener. Leave `user_root_key` empty on the first run. Provisioning
generates a 256-byte base64 key and writes it back to the file.

```sh
txt --init-owner rqlite_creds.json --verbose
```

The command creates exactly one `owner_control` row. A second, different
Firebase UID is rejected rather than added.

## Browser unlock file

Unlock the deployed UI with a separate owner-only JSON file containing exactly
the browser fields:

```json
{
  "rqlite_admin_username": "operator",
  "rqlite_admin_password": "...",
  "rqlite_db_url": "https://api.example.com/operator/rqlite",
  "firebase_email": "owner@example.com",
  "firebase_password": "...",
  "firebase_api_key": "...",
  "user_root_key": "<generated padded base64>"
}
```

`rqlite_db_url` is the same OpenResty operator route called
`rqlite_operator_url` in the provisioning file. The UI retains the selected
file's credentials and all decrypted material only in page memory; lock or
reload before leaving the device. Do not commit or upload this file.

Apply pending rqlite schema migrations (from the migration directory, not yet
recorded in `schema_migrations`) to an already-provisioned instance — this
command's migration source directory was removed with `docker/` in this
branch and needs a new source before it works again:

```sh
txt --update-rql rqlite_creds.json --verbose
```

Migrate the owner's encrypted SQLCipher database when its local schema changes:

```sh
txt --update-db owner_creds.json --local-db-dir ./data --verbose
```

Ingest EPUB files:

```sh
txt --ingest ./books --local-db-dir ./data --creds owner_creds.json --verbose
```

Prepare EPUBs or replace their images:

```sh
txt --edit-epub ./source ./edited --verbose
txt --replace-images ./source ./without-images
```

Preview and remove unreferenced owner content objects. The cleaner always
preserves gateway-owned shared objects and the server-only control-backup
prefix configured by `rqlite_control_backup`:

```sh
txt --clean-bucket owner_creds.json --verbose --dry-run
txt --clean-bucket owner_creds.json --verbose
```

Preview and remove stale (`creating`/`deleting`) share rows from both the
owner's SQLCipher database and rqlite's control database; a `creating` row
that actually registered is healed to `active` instead of removed.
`--dry-run` skips the removal but the databases are vacuumed regardless:

```sh
txt --clean-db owner_creds.json --local-db-dir ./data --verbose --dry-run
txt --clean-db owner_creds.json --local-db-dir ./data --verbose
```

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
