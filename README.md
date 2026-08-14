# txt

## Install

```
pip install -e .
```

Requires Python >= 3.14. For running tests:

```
pip install -e ".[dev]"
```

## CLI usage

```
python3 txt.py --init-admin creds.json [--verbose]
python3 txt.py --init-db creds.json [--verbose]
python3 txt.py --init-db --admin-creds admin_creds.json --user-creds user_creds.json [--verbose]
python3 txt.py --init-user --admin-creds admin_creds.json --user-creds user_creds.json [--verbose]
python3 txt.py --replace-images src_dir dst_dir [--verbose]
python3 txt.py --ingest dir --creds creds.json [--verbose]
python3 txt.py --collect-garbage --creds creds.json [--verbose]
python3 txt.py --clean-bucket --creds creds.json [--dry-run] [--verbose]
```

| flag | description |
|---|---|
| `--init-admin CREDS_JSON` | Provision the administrator account: signs into Firebase, creates its Turso database, and inserts its `ctl.users` row. |
| `--init-db CREDS_JSON` | Initialize the signed-in account's own database (admin or otherwise): applies the AA schema and sets up its key material. |
| `--init-db --admin-creds ADMIN_CREDS_JSON --user-creds USER_CREDS_JSON` | Same as above for the user side, and also pushes `{display_name, db_master_key, db_prefix}` into the admin's own AA, wrapped under the admin's own key — recoverable by the admin, unreadable by anyone else. |
| `--init-user --admin-creds ADMIN_CREDS_JSON --user-creds USER_CREDS_JSON` | Register an ordinary user's `ctl.users` row: signs in as the admin and as the target user (via their own already-signed-up Firebase credentials) to get their real uid directly, no manual lookup needed. |
| `--replace-images SRC DST` | For every `*.epub` in `SRC`, rewrite its `<img>` tags into `DST`, then copy every `*.opf` sidecar verbatim. Needs no `creds.json`. |
| `--ingest DIR --creds CREDS_JSON` | Ingest every `*.epub` in `DIR` (plus its `*.opf` sidecar, if present) into BB and R2: split, encrypt, and upload each document's parts, write its `txt`/`txt_meta`/`txt_parts` rows, and rebuild the bundle and library index if either is stale. Resumable at the filename level; safe to interrupt and rerun. |
| `--collect-garbage --creds CREDS_JSON` | Reclaim everything not needed to serve the current live state: superseded BB page versions, retired bundles, and orphaned R2 objects under `t/`, `b/`, and `i/`. Only ever deletes what's already superseded or orphaned — safe to interrupt and rerun. |
| `--clean-bucket --creds CREDS_JSON [--dry-run]` | Admin-only: sweep the whole shared R2 bucket for top-level account prefixes unknown to `ctl.users`, using backups already pushed to the admin's own AA. Refuses to delete anything if any known account's backup can't be verified; `--dry-run` reports without deleting. |
| `-v`, `--verbose` | Enable verbose progress logging. |

`creds.json` fields: `turso_org_token`, `turso_ctl_db_url`, `turso_group`, `turso_org`, `firebase_email`, `firebase_password`, `firebase_api_key`, and optionally `display_name` and `user_root_key` (generated and written back on first use if left empty). `--ingest`/`--collect-garbage`/`--clean-bucket` additionally need `r2_config`: `endpoint`, `read_only_access_key_id`, `read_only_secret_access_key`, `read_write_access_key_id`, `read_write_secret_access_key`, `region`, `bucket`.
