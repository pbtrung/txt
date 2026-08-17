# txt

The txt document-storage system: a single Turso control database (`ctl`) holding identity and wrapped key material, with all user data — one SQLCipher database per user (16 KiB pages) plus per-document content — stored in R2. A Cloudflare Worker (`worker/`) mediates client access; a Python CLI (`txt/`) administers accounts and ingests documents. See `docs/auth.md` and `docs/data_model.md` for the full design.

## Python CLI

### Install

Requires Python >= 3.14.

```
pip install -e .
```

This installs the `txt` console script (`txt.cli:run`) and its dependencies: `requests`, `click`, `wasmtime`, `brotli`, `boto3`.

### Provision an account

```
txt --init-admin creds.json --verbose                                     # the administrator's own account
txt --init-user --admin-creds admin_creds.json --user-creds user_creds.json --verbose   # an ordinary user's account
```

Creates the `users`, `key_store`, and `cred_store` tables in `ctl` if they don't already exist, signs in to Firebase to obtain that account's uid, and provisions its row (`type = 'admin'` or `'user'`) — generating and wrapping `umk` and `db_path`/`db_prefix`/`db_master_key`; the admin's row additionally gets a composite KEM keypair. Safe to re-run: each step is skipped if it's already done.

`--init-admin`'s `creds.json` requires:

```json
{
  "turso_org_token": "...",
  "turso_ctl_db_name": "...",
  "turso_ctl_db_url": "libsql://...",
  "firebase_email": "...",
  "firebase_password": "...",
  "firebase_api_key": "...",
  "display_name": "...",
  "user_root_key": ""
}
```

`--init-user` takes two separate files: `--admin-creds` is the administrator's own `creds.json` above (for `ctl`/Turso access), and `--user-creds` is the new user's own, much smaller file — the same shape the browser (`ui/`) reads directly, since an ordinary user never touches `ctl`/Turso or R2 directly, only through the Worker:

```json
{
  "firebase_email": "...",
  "firebase_password": "...",
  "firebase_api_key": "...",
  "display_name": "...",
  "user_root_key": ""
}
```

`user_root_key` is generated (256 random bytes, base64) and written back to whichever file is being provisioned (`creds.json` for `--init-admin`, `--user-creds`'s file for `--init-user`) if left empty.

### Replace images in a directory of EPUBs

```
txt --replace-images SRC DST
```

Replaces every image in each `*.epub` under `SRC` with a small placeholder and constrains its display size, writing the results to `DST`; every sidecar `*.opf` is copied alongside unchanged.

### Ingest a directory of EPUBs

```
txt --ingest SRC_DIR --local-db-dir DIR --creds creds.json --verbose
```

Uploads every `*.epub` in `SRC_DIR` to R2 as one encrypted object each, and records it in the account's `txt` table. `creds.json` is that account's own (already provisioned via `--init-admin`/`--init-user`, so `user_root_key` must already be set), plus an `r2_config` block (`endpoint`, `read_only_*`/`read_write_*` key pairs, `region`, `bucket`) since ingestion reaches R2 directly with the administrator's own bucket credentials.

The local working database lives at `DIR/{db_path}`; a run resumes from that file if present, or from the matching object in R2, or starts fresh otherwise (a fresh database's page size is set to 16 KiB before any table is created). Already-ingested files are skipped (matched by filename against each row's recorded name), so an interrupted run can simply be restarted. The local file is rewritten after every successfully ingested file; only at the end is it `VACUUM`ed and uploaded to `{bucket}/{db_path}`.

### Migrate every reachable database to `txt.catalog`

```
txt --update-db admin_creds.json --local-db-dir DIR --verbose
```

Walks every account this administrator's creds.json can reach — their own database, plus every user backup row `--init-user` has written (docs/auth.md §2) — and migrates each one still on the old `txt.metadata` column to the flat `txt.catalog` shape (docs/data_model.md §3.1): adds `catalog`, populates it by extracting `title`/`authors`/`subjects`/`publisher` out of each row's existing `metadata`, drops `metadata`, `VACUUM`s, and re-uploads. Only covers accounts with a backup `cred_store` row; anyone provisioned before that mechanism existed needs their own creds.json run individually. Idempotent and resumable at both the per-account and per-row level — an already-migrated account is skipped outright, and a partially-migrated one only re-populates rows still missing a `catalog`.

### Clean unreferenced R2 objects

```
txt --clean-bucket admin_creds.json --verbose --dry-run
```

Builds an exact allowlist from every account this administrator can reach. It downloads and decrypts each `db_path` database, retains that database object plus only the content objects referenced by its `txt_prefix`/`path` rows, then treats every other object in the configured R2 bucket as stale. This includes unreferenced uploads under a valid `{db_prefix}/`, such as objects left behind by a failed commit. A missing database references no content objects. `--dry-run` reports stale objects without deleting them; omit it to delete them. The command refuses to clean when no account rows are reachable, when any `users` row lacks an admin backup in `cred_store`, or when a database cannot be read safely.

### Common to every CLI command

`-v`/`--verbose` logs each step's progress.

### Python tests

```
pip install -e ".[dev]"
pytest
```

### Python lint/format

```
ruff check .
ruff format .
```

## Cloudflare Worker (`worker/`)

Implements docs/auth.md: exchanges a Firebase ID token for wrapped key material, and mints short-lived R2 credentials, over two endpoints.

### Install

Requires Node >= 20.

```
npm install
```

### Endpoints

- `POST /v1/keys` — verifies the caller's Firebase ID token, looks up its `ctl` row (through a KV cache and per-uid rate limit), and returns `{ type, umk, cred_store }`, still wrapped.
- `POST /v1/r2-token` — given `{ db_path, db_prefix }` (the values the client just decrypted from `cred_store`), mints a short-lived R2 credential: bucket-wide read-write for the admin, read-only scoped to both `db_path` and `db_prefix` for an ordinary user. Signed locally (Cloudflare's JWT-based temporary-credential scheme) from a single parent R2 key pair — no outbound Cloudflare API call.

### Configuration

`wrangler.jsonc` declares one KV binding, `KEYS_CACHE` (create with `wrangler kv namespace create keys-cache` and paste the resulting id in). Everything else — `FIREBASE_PROJECT_ID`, `CTL_DB_URL`, `CTL_DB_TOKEN`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION`, `R2_READ_WRITE_ACCESS_KEY_ID`, `R2_READ_WRITE_SECRET_ACCESS_KEY` (docs/auth.md §1) — is a Cloudflare dashboard Variable/Secret, never committed here; see `worker/env.d.ts`.

### Worker scripts

```
npm run worker:dev         # local dev server
npm run worker:test        # vitest
npm run worker:typecheck   # wrangler types + tsc
npm run format             # prettier --write, 88 columns
npm run format:check
npm run lint               # eslint (worker/ + ui/)
```

Deploying requires `WORKER_NAME` (the existing Cloudflare Worker's name) to be set: `WORKER_NAME=... npm run deploy`.
