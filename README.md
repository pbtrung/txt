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
```

| flag | description |
|---|---|
| `--init-admin CREDS_JSON` | Provision the administrator account: signs into Firebase, creates its Turso database, and inserts its `ctl.users` row. |
| `--init-db CREDS_JSON` | Initialize the signed-in account's own database (admin or otherwise): applies the AA schema and sets up its key material. |
| `-v`, `--verbose` | Enable verbose progress logging. |

`creds.json` fields: `turso_org_token`, `turso_ctl_db_url`, `turso_group`, `turso_org`, `firebase_email`, `firebase_password`, `firebase_api_key`, and optionally `display_name` and `user_root_key` (generated and written back on first use if left empty).
