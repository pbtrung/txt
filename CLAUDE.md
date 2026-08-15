# CLAUDE.md

This repo holds the txt document-storage system's design docs, the Cloudflare Worker that mediates client access, and the Python CLI that administers it.

## Design docs (read these before touching auth/storage code)

- `docs/auth.md` — Firebase-to-Turso/R2 auth flow: the `ctl` control database (`users`/`key_store`/`cred_store`), `/v1/keys`, `/v1/r2-token`.
- `docs/data_model.md` — the per-user SQLCipher database (`txt`/`txt_bookmarks`) and the R2 storage layout it and per-document content live under.
- `docs/crypto.md` — the AEAD/HKDF/KEM primitives (Ascon-Keccak, HKDF-SHA3-512, ML-KEM-1024+X448) and the blob format every wrapped value (`umk`, `cred_store.content`, `key_store.privkey`) uses.

## Code layout

- `txt.py` — thin entry point; also runnable as the installed `txt` console script.
- `txt/` — one module per concern:
  - `creds.py` — loads/validates `creds.json`, generates `user_root_key` if empty; also holds the optional `r2_config` (`--ingest` only).
  - `logger.py` — `--verbose` progress logging.
  - `firebase_auth.py` — Firebase email/password sign-in, returns the uid.
  - `turso_api.py` — Turso Platform API client (mints database tokens); `extract_account_name` recovers the org slug from a `libsql://` URL.
  - `libsql_client.py` — the libsql HTTP (`/v2/pipeline`) client `ctl` is queried through.
  - `random_token.py` — base32-Crockford encoding, used for `db_path`/`db_prefix`/per-document key segments.
  - `leancrypto_wasm.py` — wasmtime binding to `sqlcipher/sqlcipher.wasm`'s bundled leancrypto build (AEAD, HKDF, KEM).
  - `crypto_blob.py` — docs/crypto.md's wrap/unwrap blob format, built on `leancrypto_wasm`.
  - `sqlite_engine.py` — real SQLCipher read/write against `sqlcipher.wasm`: an in-memory `sqlite3_vfs` (function pointers installed into the wasm indirect function table via `sqlite3_js_vfs_register`) backs the whole database in a Python `bytearray`, since this build has no working native filesystem VFS and `:memory:` connections never engage the codec. Keys are 256–8192 raw bytes (`sqlite3_key`), not a passphrase.
  - `account_init.py` — `AccountInitializer`, shared by `--init-admin`/`--init-user` (parameterized by `account_type`).
  - `account_session.py` — `AccountSession`: signs in, runs `ctl`'s `users`/`key_store`/`cred_store` join, and decrypts down to an `Account` (`db_path`/`db_prefix`/`db_master_key`/`display_name`). Used by `--ingest`.
  - `r2_client.py` — `R2Client`, a thin boto3/S3-compatible wrapper for R2 (get/put object, list keys, list common prefixes, delete keys).
  - `opf.py` — Calibre `.opf` sidecar detection and `<metadata>` parsing, feeding `txt.metadata`'s nested passthrough (docs/data_model.md §3.1).
  - `ingest.py` — `TxtIngester`, the `--ingest` command: uploads each EPUB in a directory as one R2 object, keeps a resumable local SQLCipher working copy, and dedups against already-recorded filenames.
  - `replace_images.py` — `--replace-images`: replaces EPUB images with placeholders and constrains their display size; unrelated to the rest of this package's account/storage logic.
  - `cli.py` — the click entry point.
- `txt/tests/` — pytest. Crypto and SQLCipher tests run against the real wasm engine (`txt/tests/conftest.py`'s session-scoped `engine` fixture); everything else fakes only the network boundary (Firebase, the Turso Platform API, libsql HTTP, R2) — never the crypto itself.
- `sqlcipher/` — the prebuilt SQLCipher+leancrypto wasm module `leancrypto_wasm.py`/`sqlite_engine.py` load. Not built from source in this repo.
- `creds/` — local, gitignored credential files. Never commit these. Never run a command against a real one yourself — hand it to the user to run.
- `worker/` — the Cloudflare Worker implementing docs/auth.md, one module per concern:
  - `firebaseAuth.ts` — RS256/JWKS verification of a Firebase ID token, cached per the response's own `Cache-Control`.
  - `auth.ts` — bearer-token extraction + `verifiedUid`, shared by both endpoints.
  - `ctl.ts` — the `ctl` join (docs/auth.md §2) over the libsql HTTP `/v2/pipeline` protocol.
  - `cache.ts` — the `keys:{uid}` KV cache and per-uid rate limit (docs/auth.md §6).
  - `account.ts` — `getAccount`, orchestrating cache → rate limit → `ctl.ts`, shared by both endpoints (a cache hit skips the rate limiter, since it never touches the resource the limiter protects).
  - `keys.ts` — `POST /v1/keys`.
  - `r2Token.ts` — `POST /v1/r2-token`: local JWT-signing of a scoped R2 temporary credential (no outbound Cloudflare API call), from a single parent R2 key pair for both the admin's bucket-wide and an ordinary user's `db_path`/`db_prefix`-scoped credential.
  - `index.ts` — the fetch handler/router.
  - `env.d.ts` — the `Env` interface for secrets/bindings `wrangler types` doesn't know about.
- `wrangler.jsonc`, `package.json`, `scripts/deploy.sh` — Worker config/build; `scripts/deploy.sh` requires `WORKER_NAME` so a stale placeholder name in `wrangler.jsonc` can never silently target the wrong Worker, and rebuilds `ui/` fresh before every deploy. `wrangler.jsonc`'s `assets` block deploys `ui/`'s build (`dist/`) alongside the Worker script: `/v1/*` reaches `worker/index.ts`, everything else is served (or SPA-fallback-served) from `dist/`.

## Conventions

- Functions stay ≤15 lines; use a class (not free functions) for anything holding state — a client, an engine, a session.
- Reuse the existing generic pieces (`LibsqlClient`, `TursoClient`, `CryptoBlob`, `FirebaseAuth`, `AccountSession`, `R2Client`, `SqliteEngine`) instead of duplicating HTTP, crypto, or storage logic in a new command.
- `worker/*.ts` is formatted with Prettier at 88 columns (`.prettierrc.json`); run `npm run format` before committing. `.prettierignore` excludes generated/vendored files (`worker/worker-configuration.d.ts`, `sqlcipher/`) and the Python tree.
- Docs (this file, README, docs/*) describe current state only — no commit hashes, no "legacy"/"previously" framing, no narrated history.
