# txt

A fully client-side-encrypted text vault: ingest `.txt`/`.epub.txt` files via a Python CLI, then read them back through a browser-based reader — the server never sees plaintext.

See [CLAUDE.md](CLAUDE.md) for the architecture, and [docs/](docs) for the schema and key hierarchy, crypto primitives, credential model, CLI internals, UI design, deployment, and development docs.

## Features

- **Client-side encryption everywhere** — Turso (libSQL/SQLite-compatible cloud) holds only ciphertext and already-public values; document content lives in Cloudflare R2, not Turso, and every encrypt/decrypt/key-unwrap happens in `txt.py` or the browser, never in the database.
- **CLI (`txt.py`)** — ingest a directory of `.txt` files (Calibre OPF metadata sidecars picked up automatically for `.epub.txt`), download them back out, delete one or all of them, and R2 bucket housekeeping (purge everything, or just orphaned objects).
- **Web UI (`ui/`)** — a browser-based reader (Unlock/Library/Reader) over the same vault, with per-line bookmarking and read-position tracking.
- **Locally-verified boot** (`creds/local_index.html`) — an alternative entry point that cryptographically verifies every built asset before rendering anything, so a compromised CDN can't silently tamper with the app. See [docs/local_index.md](docs/local_index.md).

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

## Usage

### Configure

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
  "user_root_key": "<256+ random bytes, base64>",
  "asset_base_url": "<public URL the UI's built assets are served from>",
  "slhdsa_256f_priv_key": "<leave empty -- `ui`'s build step fills this in the first time it runs>"
}
```

See [docs/credentials.md](docs/credentials.md) for what each field means and why the admin role specifically needs the read-write R2 key pair.

### CLI

Initialize the schema and the admin account (safe to re-run — it fills in anything missing rather than erroring):

```sh
python3 txt.py --init --admin-creds admin_creds.json
```

Ingest, download, and delete:

```sh
python3 txt.py --txt-ingest txt_src/ --admin-creds admin_creds.json      # ingest every .txt file in a directory
python3 txt.py --txt-download txt_out/ --admin-creds admin_creds.json    # reconstruct every txt back into files
python3 txt.py --txt-delete --admin-creds admin_creds.json               # delete every txt (prompts unless -y/--yes)
python3 txt.py --txt-delete-id 42 --admin-creds admin_creds.json         # delete just one txt_id
```

Bucket housekeeping (both prompt for confirmation unless `-y`/`--yes`):

```sh
python3 txt.py --purge-bucket --admin-creds admin_creds.json       # delete every object in the R2 bucket
python3 txt.py --txt-clean-bucket --admin-creds admin_creds.json   # delete only objects orphaned in the DB
```

Add `-v`/`--verbose` to any command for debug-level logging. Run `python3 txt.py --help` for the full option list, or see [docs/cli.md](docs/cli.md) for how each command works internally.

### Web UI

```sh
cd ui
npm install
npm run dev      # http://localhost:5173
npm run build -- --admin-creds ../creds/admin_creds.json    # -> ui/dist + creds/local_index.html
```

It reads a config file shaped like `user_cred_template.json` but without `r2_config` — that's fetched from Turso's `r2_config` table and decrypted with the account's `umk` instead. A Cloudflare R2 bucket needs a CORS policy set before the UI can read from it at all (see [docs/deployment.md](docs/deployment.md)); for local development, tests, and verbose logging, see [docs/development.md](docs/development.md).

## License

[MIT](LICENSE)
