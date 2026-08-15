# CLAUDE.md

This repo holds the txt document-storage system's design docs and the Python CLI that administers it.

## Design docs (read these before touching auth/storage code)

- `docs/auth.md` — Firebase-to-Turso/R2 auth flow: the `ctl` control database (`users`/`key_store`/`cred_store`), `/v1/keys`, `/v1/r2-token`.
- `docs/data_model.md` — the per-user SQLCipher database (`txt`/`txt_bookmarks`) and the R2 storage layout it and per-document content live under.
- `docs/crypto.md` — the AEAD/HKDF/KEM primitives (Ascon-Keccak, HKDF-SHA3-512, ML-KEM-1024+X448) and the blob format every wrapped value (`umk`, `cred_store.content`, `key_store.privkey`) uses.

## Code layout

- `txt.py` — thin entry point; also runnable as the installed `txt` console script.
- `txt/` — one module per concern:
  - `creds.py` — loads/validates `creds.json`, generates `user_root_key` if empty.
  - `logger.py` — `--verbose` progress logging.
  - `firebase_auth.py` — Firebase email/password sign-in, returns the uid.
  - `turso_api.py` — Turso Platform API client (mints database tokens); `extract_account_name` recovers the org slug from a `libsql://` URL.
  - `libsql_client.py` — the libsql HTTP (`/v2/pipeline`) client `ctl` is queried through.
  - `random_token.py` — base32-Crockford encoding, used for `db_path`/`db_prefix`.
  - `leancrypto_wasm.py` — wasmtime binding to `sqlcipher/sqlcipher.wasm`'s bundled leancrypto build (AEAD, HKDF, KEM).
  - `crypto_blob.py` — docs/crypto.md's wrap/unwrap blob format, built on `leancrypto_wasm`.
  - `admin_init.py` — the `--init-admin` command.
  - `cli.py` — the click entry point.
- `txt/tests/` — pytest. Crypto tests run against the real wasm engine (`txt/tests/conftest.py`'s session-scoped `engine` fixture); everything else fakes only the network boundary (Firebase, the Turso Platform API, libsql HTTP) — never the crypto itself.
- `sqlcipher/` — the prebuilt SQLCipher+leancrypto wasm module `leancrypto_wasm.py` loads. Not built from source in this repo.
- `creds/` — local, gitignored credential files. Never commit these. Never run a command against a real one yourself — hand it to the user to run.

## Conventions

- Functions stay ≤15 lines; use a class (not free functions) for anything holding state — a client, an engine, a session.
- Reuse the existing generic pieces (`LibsqlClient`, `TursoClient`, `CryptoBlob`, `FirebaseAuth`) instead of duplicating HTTP or crypto logic in a new command.
- Docs (this file, README, docs/*) describe current state only — no commit hashes, no "legacy"/"previously" framing, no narrated history.
