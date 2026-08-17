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

R2 is always the source of truth. Every run downloads `{db_path}` even when `DIR/{db_path}` exists; the local file is only an inspection/checkpoint copy and is never trusted as an upload base. Already-ingested files are skipped by the names in the downloaded database. The local file is rewritten after every ingested file, then the changed database is `VACUUM`ed and uploaded with `If-Match` (or `If-None-Match: *` for its first creation). If a browser changes the database concurrently, the command exits on the precondition failure without overwriting it; rerun to ingest against the newer remote database. Content objects from the failed attempt are harmless orphans that `--clean-bucket` can remove.

### Migrate every reachable database to `txt.catalog`

```
txt --update-db admin_creds.json --local-db-dir DIR --verbose
```

Walks every account this administrator's creds.json can reach — their own database, plus every user backup row `--init-user` has written (docs/auth.md §2) — and migrates `txt.metadata` to `txt.catalog`, adds `txt.last_cfi`, and installs the CFI bookmark table/index/cap trigger (docs/data_model.md §3). It always starts from the current R2 object, writes `DIR/{db_path}` only as a checkpoint, and conditionally uploads changed databases against their downloaded ETags. A concurrent write therefore aborts safely; rerun against the new object. Already-current databases are not uploaded.

### Clean unreferenced R2 objects

```
txt --clean-bucket admin_creds.json --verbose --dry-run
```

Builds an exact allowlist from every account this administrator can reach. It downloads and decrypts each `db_path` database, retains that database object plus only the content objects referenced by its `txt_prefix`/`path` rows, then treats every other object in the configured R2 bucket as stale. This includes unreferenced uploads under a valid `{db_prefix}/`, such as objects left behind by a failed commit. A missing database references no content objects. `--dry-run` reports stale objects without deleting them; omit it to delete them. The command refuses to clean when no account rows are reachable, when any `users` row lacks an admin backup in `cred_store`, or when a database cannot be read safely.

Cleanup progress is printed to the console and appended to `run.log`, including cumulative progress after every R2 listing or deletion batch of up to 1,000 objects. Use `--log-file FILE` to choose another path. With `--verbose`, each stale object is also recorded individually.

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

- `POST /v1/keys` — verifies the Firebase ID token and returns the account's wrapped `umk`, credential store, and versioned wrapped signing private key.
- `POST /v1/r2-token` — verifies the authenticated user's short-lived P-521 path proof and SHA-512 path binding, then returns two credentials: read-write for exactly `db_path`, and read-only for `{db_prefix}/*`.

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

### R2 CORS and write-access rollout

The browser talks directly to the R2 S3 endpoint, so the bucket must permit its exact production origin to make `GET` and `PUT` requests, accept the AWS signing and conditional headers, and expose `ETag`. Start from `docs/r2-cors.example.json`, replace `https://reader.example.com`, and apply it to the bucket through Cloudflare's R2 CORS settings. Keep development origins in a separate rule; do not replace the origin with `*`.

Roll out in this order:

1. Back up `ctl` and the R2 bucket, then re-run account provisioning as needed so every account has `db_binding_hash` and the version-1 P-521 signing fields.
2. While the deployed UI is still read-only, run `txt --update-db ...` for every reachable account and resolve any legacy-bookmark or conditional-write failure.
3. Apply and verify the bucket CORS policy, including a preflight that requests `If-Match` and confirms `ETag` is exposed.
4. Deploy the Worker and UI together with `WORKER_NAME=... npm run deploy`. The versioned `keys:v2:*` cache namespace makes old account-cache entries automatic misses; explicit per-user purges still delete both old and current keys.
5. Smoke-test unlock, resume, a bookmark create/delete, and a two-tab write conflict before broadening access. Keep the previous deployment available for rollback; added database columns/tables are backward-compatible with the old read-only UI.

Deploying requires `WORKER_NAME` (the existing Cloudflare Worker's name) to be set: `WORKER_NAME=... npm run deploy`.
