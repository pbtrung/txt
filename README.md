# txt

`txt` is a single-owner encrypted EPUB library. The React application keeps the
library database and book contents encrypted in R2, while an OpenResty Lua API
and a loopback-only rqlite database run in one container on Northflank. There is
exactly one authenticated owner. There are no registrations, invitations,
roles, or account-management screens.

The owner can create public read-only links. A recipient does not become an
account: the link is a bearer capability that lets the recipient request a
short-lived, exact-object R2 URL and decrypt that shared copy in the browser.

See [authentication](docs/auth.md), [control database](docs/control_database.md),
[data model](docs/data_model.md), [storage layout](docs/storage_layout.md),
[sharing](docs/sharing.md), [cryptography](docs/crypto.md), and
[deployment](docs/deployment.md) for the complete design.

## Architecture

```text
Browser ── HTTPS ─┬─> OpenResty /v1 Lua API ───┬─> rqlite
                  │                              └─> Cloudflare R2
                  ├─> OpenResty /operator/rqlite/ ──> rqlite
                  └─> Cloudflare R2 encrypted objects
```

- The owner signs in with Firebase; the API accepts only the configured owner
  UID.
- The owner's SQLCipher library database is one conditionally updated R2
  object.
- Every EPUB is a separate immutable encrypted R2 object.
- The browser performs EPUB encryption and decryption. The API never receives
  plaintext books or share content keys.
- During unlock, the owner browser reads wrapped singleton material through the
  Basic-authenticated rqlite operator proxy and obtains an R2 binding ticket
  through the Firebase-authenticated API. All three owner UIDs must agree.
- rqlite is the only server-side database. It stores the singleton owner control
  record, the share registry, schema versions, and rate-limit counters.
- Shared EPUB downloads go directly from R2 to the recipient through a
  short-lived presigned URL; EPUB bytes do not pass through Northflank.

## Main features

- One in-memory unlocked owner session with locally opened SQLCipher data.
- Searchable catalog metadata, reading position, CFI bookmarks, and responsive
  EPUB rendering.
- P-521 proof of possession before the API signs temporary owner R2 access.
- Exact-path and prefix-scoped R2 authorization with conditional database
  updates.
- Owner-created, independently encrypted, revocable public shares.
- Direct R2 downloads through 60-second exact-object presigned URLs.
- A loopback-only single-node rqlite control database with durable storage and
  native hot backups to private R2 storage.

## Install

Requires Python 3.14 or newer and Node.js 20 or newer.

```sh
pip install -e ".[dev]"
npm install
```

## Owner provisioning

Provisioning is a one-time, idempotent operation. The exact credential-file
shape and field descriptions are in [the deployment guide](docs/deployment.md#3-owner-initialization).
`rqlite_operator_url` is the externally reachable Basic-auth operator route,
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

Apply pending rqlite schema migrations (`docker/migrations/NNNN_*.sql` not yet
recorded in `schema_migrations`) to an already-provisioned instance:

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

Preview and remove unreferenced owner content objects:

```sh
txt --clean-bucket owner_creds.json --verbose --dry-run
txt --clean-bucket owner_creds.json --verbose
```

## Development checks

```sh
pytest
npm run ui:test
npm run lint
```

Deployment configuration, rqlite initialization, R2 CORS, backups, and
end-to-end verification are specified in [docs/deployment.md](docs/deployment.md).
