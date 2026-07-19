# txt

A fully client-side-encrypted text vault. [Turso](https://turso.tech) (libSQL/SQLite-compatible cloud) holds all structured data — accounts, wrapped keys, R2 object paths, sharing grants, bookmarks, and read-position — but only ever sees ciphertext, or values that are already public. Document content itself lives in Cloudflare R2 object storage, not Turso; Turso only holds the (wrapped) R2 path. All encryption, decryption, and key (un)wrapping happens client-side, via `txt.py`, never in the database.

See [CLAUDE.md](CLAUDE.md) for the full architecture, and [docs/](docs) for the schema, key hierarchy, crypto primitives, and credential model.

## Requirements

- Python 3.14+
- [leancrypto](https://leancrypto.org) (AEAD, HKDF, HMAC, PBKDF2, and the ML-KEM-1024 + X448 KEM), installed as a shared library findable by `ctypes.util.find_library` (e.g. on Arch/CachyOS: `yay -S leancrypto`, then `ldconfig`)
- A Turso database
- A Cloudflare R2 bucket, with a read-only and a read-write API key pair

## Install

```sh
pip install click libsql brotli boto3
```

(There's no `requirements.txt`/`pyproject.toml` yet — these are the only third-party packages `txt.py` imports.)

## Configure

Create `admin_creds.json` with the following shape:

```json
{
  "turso_database_url": "libsql://<your-db>.turso.io",
  "turso_auth_token": "<a read-write Turso token>",
  "username": "<login handle>",
  "username_lookup_key": "<32+ random bytes, base64>",
  "password": "<login password>",
  "display_name": "<display name>",
  "r2_config": {
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "read_only_access_key_id": "...",
    "read_only_secret_access_key": "...",
    "read_write_access_key_id": "...",
    "read_write_secret_access_key": "...",
    "region": "auto",
    "bucket": "..."
  },
  "user_root_key": "<256+ random bytes, base64>"
}
```

See [docs/credentials.md](docs/credentials.md) for what each field means and why the admin role specifically needs the read-write R2 key pair.

## Use

Initialize the schema and the admin account (safe to re-run — it fills in anything missing rather than erroring):

```sh
python3 txt.py --init --admin-creds admin_creds.json
```

Ingest every `.txt` file (matched case-insensitively) from a directory into the vault:

```sh
python3 txt.py --add-txt --src txt_src/ --admin-creds admin_creds.json
```

Add `-v`/`--verbose` to either command for debug-level logging. Run `python3 txt.py --help` for the full option list.

## License

[MIT](LICENSE)
