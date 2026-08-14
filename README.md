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
python3 txt.py --replace-images src_dir dst_dir [--verbose]
python3 txt.py --ingest dir --creds creds.json [--verbose]
python3 txt.py --collect-garbage --creds creds.json [--verbose]
```

| flag | description |
|---|---|
| `--init-admin CREDS_JSON` | Provision the administrator account: signs into Firebase, creates its Turso database, and inserts its `ctl.users` row. |
| `--init-db CREDS_JSON` | Initialize the signed-in account's own database (admin or otherwise): applies the AA schema and sets up its key material. |
| `--replace-images SRC DST` | For every `*.epub` in `SRC`, rewrite its `<img>` tags into `DST`, then copy every `*.opf` sidecar verbatim. Needs no `creds.json`. |
| `--ingest DIR --creds CREDS_JSON` | Ingest every `*.epub` in `DIR` (plus its `*.opf` sidecar, if present) into BB and R2: split, encrypt, and upload each document's parts, write its `txt`/`txt_meta`/`txt_parts` rows, and rebuild the bundle and library index if either is stale. Resumable at the filename level; safe to interrupt and rerun. |
| `--collect-garbage --creds CREDS_JSON` | Reclaim everything not needed to serve the current live state: superseded BB page versions, retired bundles, and orphaned R2 objects under `t/`, `b/`, and `i/`. Only ever deletes what's already superseded or orphaned — safe to interrupt and rerun. |
| `-v`, `--verbose` | Enable verbose progress logging. |

`creds.json` fields: `turso_org_token`, `turso_ctl_db_url`, `turso_group`, `turso_org`, `firebase_email`, `firebase_password`, `firebase_api_key`, and optionally `display_name` and `user_root_key` (generated and written back on first use if left empty). `--ingest`/`--collect-garbage` additionally need `r2_config`: `endpoint`, `read_only_access_key_id`, `read_only_secret_access_key`, `read_write_access_key_id`, `read_write_secret_access_key`, `region`, `bucket`.
