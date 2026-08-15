# txt

CLI for administering the txt document-storage system: a single Turso control database (`ctl`) holding identity and wrapped key material, with all user data — one SQLCipher database per user plus per-document content — stored in R2. See `docs/auth.md` and `docs/data_model.md` for the full design.

## Install

Requires Python >= 3.14.

```
pip install -e .
```

This installs the `txt` console script (`txt.cli:run`) and its dependencies: `requests`, `click`, `wasmtime`, `brotli`, `boto3`.

## Usage

### Provision an account

```
txt --init-admin creds.json --verbose   # the administrator's own account
txt --init-user creds.json --verbose    # an ordinary user's account
```

Creates the `users`, `key_store`, and `cred_store` tables in `ctl` if they don't already exist, signs in to Firebase to obtain that account's uid, and provisions its row (`type = 'admin'` or `'user'`) — generating and wrapping `umk` and `db_path`/`db_prefix`/`db_master_key`; the admin's row additionally gets a composite KEM keypair. Safe to re-run: each step is skipped if it's already done.

`creds.json` requires:

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

`user_root_key` is generated (256 random bytes, base64) and written back to the file if left empty.

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

The local working database lives at `DIR/{db_path}`; a run resumes from that file if present, or from the matching object in R2, or starts fresh otherwise. Already-ingested files are skipped (matched by filename against each row's recorded name), so an interrupted run can simply be restarted. The local file is rewritten after every successfully ingested file; only at the end is it `VACUUM`ed and uploaded to `{bucket}/{db_path}`.

### Common to every command

`-v`/`--verbose` logs each step's progress.

## Tests

```
pip install -e ".[dev]"
pytest
```
