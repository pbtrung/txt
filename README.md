# txt

`txt` is an encrypted document library with a React reader, a Cloudflare Worker API, and a Python administration CLI. User databases and document content live encrypted in R2; Turso stores identity, hashes, and wrapped key material only.

See [authentication](docs/auth.md), [data model](docs/data_model.md), and [cryptography](docs/crypto.md) for the detailed design.

## Main features

- One locally opened SQLCipher database per user, stored as a conditionally updated R2 object.
- Separately encrypted EPUB content with searchable catalog metadata, reading position, and CFI bookmarks.
- Firebase authentication for key retrieval and stateless 24-hour binding tickets for later R2 credential renewal.
- P-521 proof-of-possession bound to the decrypted user handle and authorized storage paths.
- Least-privilege 15-minute R2 credentials: read-write for one database object, with an ordinary-user read-only content prefix and an administrator read-write content prefix.
- Administrator-created public book links with independently encrypted content, opaque object paths, and authoritative deletion through a D1 live-share registry.
- Idempotent account provisioning, control/database migrations, EPUB ingestion, and safe orphan cleanup through the CLI.
- Responsive React library and reader UI with in-memory-only unlocked sessions.

## Install

Requires Python 3.14 or newer and Node.js 20 or newer.

```sh
pip install -e ".[dev]"
npm install
```

## Usage

Administrator credentials contain Turso, Firebase, display-name, and `user_root_key` fields. Ordinary-user credentials contain only Firebase, display-name, and `user_root_key` fields. Leave `user_root_key` empty during initial provisioning; the CLI generates and writes a 256-byte base64 key back to that file. Field definitions and the encrypted backup model are documented in [docs/auth.md](docs/auth.md).

Provision accounts:

```sh
txt --init-admin admin_creds.json --verbose
txt --init-user \
  --admin-creds admin_creds.json \
  --user-creds user_creds.json \
  --verbose
```

For an existing control database, re-run provisioning so the administrator account and every ordinary account receive the current path binding, signing key, and encrypted backup shape. Then preview and apply the handle-hash migration:

```sh
txt --init-admin admin_creds.json --verbose
txt --init-user \
  --admin-creds admin_creds.json \
  --user-creds user_creds.json \
  --verbose
txt --update-ctl admin_creds.json --verbose --dry-run
txt --update-ctl admin_creds.json --verbose
```

Migrate all reachable encrypted user databases:

```sh
txt --update-db admin_creds.json --local-db-dir ./data --verbose
```

Ingest EPUB files for a provisioned account whose credentials include `r2_config`:

```sh
txt --ingest ./books --local-db-dir ./data --creds creds.json --verbose
```

Prepare EPUBs or replace their images:

```sh
txt --edit-epub ./source ./edited --verbose
txt --replace-images ./source ./without-images
```

Preview and remove unreferenced R2 objects:

```sh
txt --clean-bucket admin_creds.json --verbose --dry-run
txt --clean-bucket admin_creds.json --verbose
```

Run checks and local development:

```sh
pytest
npm run worker:test
npm run ui:test
npm run lint
npm run worker:dev
npm run ui:dev
```

For deployment, configure `KEYS_CACHE`, create the D1 registry, and replace the generated binding ids in `wrangler.jsonc`. Apply the registry migration before serving share links:

```sh
npx wrangler kv namespace create keys-cache
npx wrangler d1 create txt-share-registry
npx wrangler d1 execute SHARE_REGISTRY --remote \
  --file worker/migrations/0001_share_registry.sql
```

Install the variables and secrets listed in [docs/auth.md](docs/auth.md), including `ADMIN_UID`, an independent `R2_TICKET_SECRET`, and an independent `SHARE_GRANT_KEY`. Generate the two keys separately:

```sh
openssl rand -base64 32  # R2_TICKET_SECRET
openssl rand -base64 32  # SHARE_GRANT_KEY
```

Configure R2 CORS for the exact UI origin, then deploy the Worker and UI together:

```sh
WORKER_NAME=existing-worker npm run deploy
```
