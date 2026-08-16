# CLAUDE.md

This repo holds the txt document-storage system's design docs, the Cloudflare Worker that mediates client access, and the Python CLI that administers it.

## Design docs (read these before touching auth/storage code)

- `docs/auth.md` — Firebase-to-Turso/R2 auth flow: the `ctl` control database (`users`/`key_store`/`cred_store`), `/v1/keys`, `/v1/r2-token`.
- `docs/data_model.md` — the per-user SQLCipher database (`txt`/`txt_bookmarks`) and the R2 storage layout it and per-document content live under.
- `docs/crypto.md` — the AEAD/HKDF/KEM primitives (Ascon-Keccak, HKDF-SHA3-512, ML-KEM-1024+X448) and the blob format every wrapped value (`umk`, `cred_store.content`, `key_store.privkey`) uses.

## Code layout

- `txt.py` — thin entry point; also runnable as the installed `txt` console script.
- `txt/` — one module per concern:
  - `creds.py` — loads/validates `creds.json` (`Creds`, the administrator's own full shape, `r2_config` included, `--ingest`/`--init-admin`) or a reduced `UserCreds` (`--init-user`'s `--user-creds`, matching `ui/src/data/creds.ts`'s `BrowserCreds` — no `turso_org_token`/`r2_config`, since an ordinary user only ever reaches `ctl`/R2 through the Worker); generates `user_root_key` if empty for either shape.
  - `logger.py` — `--verbose` progress logging.
  - `firebase_auth.py` — Firebase email/password sign-in, returns the uid.
  - `turso_api.py` — Turso Platform API client (mints database tokens); `extract_account_name` recovers the org slug from a `libsql://` URL.
  - `libsql_client.py` — the libsql HTTP (`/v2/pipeline`) client `ctl` is queried through.
  - `random_token.py` — base32-Crockford encoding, used for `db_path`/`db_prefix`/per-document key segments.
  - `leancrypto_wasm.py` — wasmtime binding to `sqlcipher/sqlcipher.wasm`'s bundled leancrypto build (AEAD, HKDF, KEM).
  - `crypto_blob.py` — docs/crypto.md's wrap/unwrap blob format, built on `leancrypto_wasm`.
  - `sqlite_engine.py` — real SQLCipher read/write against `sqlcipher.wasm`: an in-memory `sqlite3_vfs` (function pointers installed into the wasm indirect function table via `sqlite3_js_vfs_register`) backs the whole database in a Python `bytearray`, since this build has no working native filesystem VFS and `:memory:` connections never engage the codec. Keys are 256–8192 raw bytes (`sqlite3_key`), not a passphrase.
  - `account_init.py` — `AccountInitializer`, shared by `--init-admin`/`--init-user` (parameterized by `account_type`). Takes `admin_creds` (`ctl`/Turso access) and `target_creds` (whichever account is being provisioned — the same object as `admin_creds` for `--init-admin`, a separate `UserCreds` for `--init-user`) separately, since only the target's own Firebase identity is needed to discover its uid.
  - `account_session.py` — `AccountSession`: signs in, runs `ctl`'s `users`/`key_store`/`cred_store` join, and decrypts down to an `Account` (`db_path`/`db_prefix`/`db_master_key`/`display_name`). Used by `--ingest`.
  - `r2_client.py` — `R2Client`, a thin boto3/S3-compatible wrapper for R2 (get/put object, list keys, list common prefixes, delete keys).
  - `opf.py` — Calibre `.opf` sidecar detection and `<metadata>` parsing; `ingest.py` extracts just `title`/`authors`/`subjects`/`publisher` from it into `txt.catalog` (docs/data_model.md §3.1).
  - `ingest.py` — `TxtIngester`, the `--ingest` command: uploads each EPUB in a directory as one R2 object, keeps a resumable local SQLCipher working copy, and dedups against already-recorded filenames.
  - `db_updater.py` — `DbUpdater`, the `--update-db` command: migrates every account an administrator's creds.json can reach (their own database, plus every user backup row `account_init.py`'s admin-backup mechanism has written) from `txt.metadata` to `txt.catalog` (docs/data_model.md §3.1), idempotent and resumable at both the per-account and per-row level.
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
- `worker/tests/`, `ui/tests/` — vitest, mirroring each tree's own source subdirectory structure (e.g. `ui/tests/screens/Reader/ReaderScreen.test.tsx` for `ui/src/screens/Reader/ReaderScreen.tsx`) rather than living alongside the source files they test.
- `wrangler.jsonc`, `package.json`, `scripts/deploy.sh` — Worker config/build; `scripts/deploy.sh` requires `WORKER_NAME` so a stale placeholder name in `wrangler.jsonc` can never silently target the wrong Worker, and rebuilds `ui/` fresh before every deploy. `wrangler.jsonc`'s `assets` block deploys `ui/`'s build (`dist/`) alongside the Worker script: `/v1/*` reaches `worker/index.ts`, everything else is served (or SPA-fallback-served) from `dist/`.
- `ui/_headers` — response headers (CSP, `X-Frame-Options`, `Permissions-Policy`, ...) Cloudflare Workers Static Assets applies to every `dist/` response, same syntax as Cloudflare Pages; `npm run ui:build` copies it into `dist/`. The CSP's `connect-src` is the only thing it restricts beyond that — deliberately no `script-src`/`style-src`/`default-src`, since epub.ts renders each book section in its own sandboxed `srcdoc` iframe, which inherits this same policy.

## Conventions

- Functions stay ≤15 lines; use a class (not free functions) for anything holding state — a client, an engine, a session.
- Reuse the existing generic pieces (`LibsqlClient`, `TursoClient`, `CryptoBlob`, `FirebaseAuth`, `AccountSession`, `R2Client`, `SqliteEngine`) instead of duplicating HTTP, crypto, or storage logic in a new command.
- `worker/*.ts` is formatted with Prettier at 88 columns (`.prettierrc.json`); run `npm run format` before committing. `.prettierignore` excludes generated/vendored files (`worker/worker-configuration.d.ts`, `sqlcipher/`) and the Python tree.
- The Python tree is linted and formatted with ruff (`[tool.ruff]` in `pyproject.toml`, 88 columns to match the TS side): `python3 -m ruff check .` and `python3 -m ruff format .` before committing.
- `worker/` and `ui/` are linted with ESLint (`eslint.config.js`): `npm run lint` before committing.
- The project's own TypeScript is 7.x (`typescript7`, aliased since typescript-eslint doesn't support TS 7 yet); a plain `typescript@6.0.3` devDependency exists solely to satisfy typescript-eslint's own peer range. `npm run tsc` (used by every `*:typecheck`/`ui:build` script) always resolves to the real 7.x compiler, never the 6.x one — the alias exists only so both can coexist under `node_modules` without conflict.
- Docs (this file, README, docs/*) describe current state only — no commit hashes, no "legacy"/"previously" framing, no narrated history.
