# txt

`txt` is an encrypted document library with a React reader, a Cloudflare Worker API, and a Python administration CLI. User databases and document content live encrypted in R2; Turso stores identity, hashes, and wrapped key material only.

See [authentication](docs/auth.md), [data model](docs/data_model.md), and [cryptography](docs/crypto.md) for the detailed design. The evaluated Rivet alternative is in [docs/rivet_actor.md](docs/rivet_actor.md).

## Main features

- One locally opened SQLCipher database per user, stored as a conditionally updated R2 object.
- Separately encrypted EPUB content with searchable catalog metadata, reading position, and CFI bookmarks.
- Firebase authentication for key retrieval and stateless 24-hour binding tickets for later R2 credential renewal.
- P-521 proof-of-possession bound to the decrypted user handle and authorized storage paths.
- Least-privilege 15-minute R2 credentials: read-write for one database object and read-only for one content prefix.
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

For a legacy installation, re-run `--init-user` for every ordinary user so the encrypted administrator backups contain their root keys. Then preview and apply the control-plane migration:

```sh
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

For deployment, configure the `KEYS_CACHE` KV binding and the secrets listed in [docs/auth.md](docs/auth.md), including a dedicated standard-base64 ticket secret generated with `openssl rand -base64 32`. Apply [the R2 CORS example](docs/r2-cors.example.json) for the exact UI origin, then deploy the Worker and UI together:

```sh
WORKER_NAME=existing-worker npm run deploy
```
