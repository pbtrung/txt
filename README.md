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

Ingest every `.txt` file (matched case-insensitively) from a directory into the vault — already-ingested filenames are skipped, and a `<name>.epub.txt` file with a sibling `<name>.opf` (a Calibre metadata sidecar, also matched case-insensitively) gets that OPF's `<metadata>` recorded alongside it:

```sh
python3 txt.py --txt-ingest txt_src/ --admin-creds admin_creds.json
```

Download every txt back out, concatenating each document's parts into a single file per document:

```sh
python3 txt.py --txt-download txt_out/ --admin-creds admin_creds.json
```

Delete every txt, its R2 parts, and all dependent rows (shares, bookmarks, read-position) — prompts for confirmation unless `-y`/`--yes` is given:

```sh
python3 txt.py --txt-delete --admin-creds admin_creds.json
```

Delete every object in the R2 bucket, regardless of what the DB knows about — prompts for confirmation unless `-y`/`--yes` is given:

```sh
python3 txt.py --purge-bucket --admin-creds admin_creds.json
```

Delete every R2 object that isn't referenced by any of this account's txt_parts — housekeeping for objects orphaned by e.g. a crash mid-ingest — prompts for confirmation unless `-y`/`--yes` is given:

```sh
python3 txt.py --txt-clean-bucket --admin-creds admin_creds.json
```

`--txt-ingest`/`--txt-download`/`--txt-delete`/`--purge-bucket`/`--txt-clean-bucket` all operate on parts/objects concurrently, capped at `R2_NUM_THREADS` (see `txt/constants.py`) parallel R2 requests, and R2 reads/writes/deletes retry with exponential backoff (2s/4s/8s, up to 3 retries) before giving up. Add `-v`/`--verbose` to any command for debug-level logging. Run `python3 txt.py --help` for the full option list.

## Test

```sh
pip install pytest pytest-cov
pytest --cov=txt --cov-report=term-missing
```

Unit tests live in `tests/`; `tests/test_crypto.py` covers `txt/crypto.py`'s blob format, AEAD, KDF, and KEM primitives against the real `leancrypto` bindings (no mocking).

## Web UI

`ui/` is a client-side-encrypted web reader (React + TypeScript + Vite) for the same
vault: Unlock, Library, and Reader screens per [docs/ui.md](docs/ui.md)'s design. All
crypto and R2/Turso access happens in the browser, mirroring `txt/crypto.py`/`txt/owner.py`
in TypeScript (`ui/src/crypto/`, `ui/src/data/`) — the same leancrypto AEAD/HKDF/KEM
primitives (via the prebuilt `ui/leancrypto/leancrypto.js`/`.wasm`), the same blob format,
the same schema. It reads a config file shaped like `user_cred_template.json` but without
`r2_config` — that's fetched from Turso's `r2_config` table and decrypted with the
account's `umk` instead, same as `key_store.priv_key`.

```sh
cd ui
npm install
npm run dev      # http://localhost:5173
npm test
npm run build    # -> ui/dist
```

### Verbose logging

On by default. Load the app with `?verbose=0` in the URL to turn it off for that page
load (`ui/src/log.ts`; toggle mid-session with `setVerbose()` instead of reloading if you
don't want to lose an in-progress session — it isn't persisted across reloads, same as
`VaultContext`'s own session state). It logs `unlock()`'s steps
(`ui/src/state/VaultContext.tsx` — parsing the config, resolving the user id, checking
the password, unwrapping `umk`, loading metadata/access/bookmarks) and every
`db.execute()` call, from any screen, logs its SQL/args and either its row count or its
error (`ui/src/data/db.ts`).

### R2 bucket CORS policy (required)

Cloudflare R2 buckets ship with **no CORS policy at all** by default, which silently
blocks every part fetch: a signed GET carries an `Authorization`/`x-amz-date`/
`x-amz-content-sha256` header set, making it a "non-simple" cross-origin request, so the
browser sends a CORS preflight (`OPTIONS`) before it — and with no policy, that preflight
has nothing to grant it, failing with a `TypeError: Failed to fetch` that looks identical
to a plain network error (the browser deliberately doesn't distinguish the two). This only
affects the browser UI, not `txt.py` (boto3 runs server-side, unaffected by CORS).

Set a policy on the bucket (Cloudflare dashboard → R2 → your bucket → Settings → CORS
Policy, or `aws s3api put-bucket-cors --endpoint-url <r2 endpoint> ...`) allowing GET from
wherever the UI is served:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

Add every origin the UI is actually served from (e.g. a deployed origin, not just
`localhost`) as another entry in `AllowedOrigins`. `AllowedHeaders: ["*"]` is the safe
default — a narrower list has to include every header the SigV4 signature adds, or the
preflight still fails the same way.

## License

[MIT](LICENSE)
