# txt

CLI for administering the txt document-storage system: a single Turso control database (`ctl`) holding identity and wrapped key material, with all user data — one SQLCipher database per user plus per-document content — stored in R2. See `docs/auth.md` and `docs/data_model.md` for the full design.

## Install

Requires Python >= 3.14.

```
pip install -e .
```

This installs the `txt` console script (`txt.cli:run`) and its dependencies: `requests`, `click`, `wasmtime`, `brotli`.

## Usage

### Provision the administrator

```
txt --init-admin creds.json --verbose
```

Creates the `users`, `key_store`, and `cred_store` tables in `ctl` if they don't already exist, signs in to Firebase to obtain the administrator's uid, and provisions its row (`type = 'admin'`) — generating and wrapping `umk`, a composite KEM keypair, and `db_path`/`db_prefix`/`db_master_key`. Safe to re-run: each step is skipped if it's already done.

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

`-v`/`--verbose` logs each step's progress.

## Tests

```
pip install -e ".[dev]"
pytest
```
