# CLAUDE.md

This repo holds the txt document-storage system's design docs, the Cloudflare Worker that mediates client access, and the Python CLI that administers it.

## Design docs (read these before touching auth/storage code)

- `docs/auth.md` — Firebase-to-Turso/R2 auth flow: the `ctl` control database (`users`/`key_store`/`cred_store`), `/v1/keys`, `/v1/r2-token`.
- `docs/data_model.md` — the per-user SQLCipher database (`txt`/`txt_bookmarks`) schema and its conditional read-write round trip against R2.
- `docs/storage_layout.md` — the R2 object-key layout the per-user database and per-document content live under.
- `docs/sharing.md` — the public document-sharing feature: the D1 share registry, `/v1/share-grant`/`/v1/share`/`/v1/shared-content`, and the share-grant crypto envelope.
- `docs/crypto.md` — the AEAD/HKDF/KEM primitives (Ascon-Keccak, HKDF-SHA3-512, ML-KEM-1024+X448) and the blob format every wrapped value (`umk`, `cred_store.content`, `key_store.privkey`) uses.
- `docs/deployment.md` — R2 CORS configuration and the rollout order for shipping control-plane, schema, or Worker-secret changes.

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
  - `opf.py` — Calibre `.opf` sidecar detection and `<metadata>` parsing; `ingest.py` extracts just `title`/`authors`/`subjects`/`publisher` from it into `txt.catalog` (docs/data_model.md §2.1).
  - `ingest.py` — `TxtIngester`, the `--ingest` command: uploads each EPUB in a directory as one R2 object, keeps a resumable local SQLCipher working copy, and dedups against already-recorded filenames.
  - `ctl_updater.py` — `CtlUpdater`, the `--update-ctl` command: validates every self-owned/admin-backup credential payload reachable with the administrator credentials, installs encrypted user handles and their Turso hashes, and supports a full `--dry-run` preview.
  - `db_updater.py` — `DbUpdater`, the `--update-db` command: migrates and validates the complete catalog, CFI reading-state, bookmark, share, and named-migration schema for every account an administrator's creds.json can reach. R2 is always the input; local files are inspection checkpoints only.
  - `replace_images.py` — `--replace-images`: replaces EPUB images with placeholders and constrains their display size; unrelated to the rest of this package's account/storage logic.
  - `edit_epub.py` — `--edit-epub`: splits EPUB spine items into soft 1.2 MB parts, rewrites title/series metadata and sidecars, then applies the same image replacement rules as `--replace-images`.
  - `cli.py` — the click entry point.
- `txt/tests/` — pytest. Crypto and SQLCipher tests run against the real wasm engine (`txt/tests/conftest.py`'s session-scoped `engine` fixture); everything else fakes only the network boundary (Firebase, the Turso Platform API, libsql HTTP, R2) — never the crypto itself.
- `sqlcipher/` — the prebuilt SQLCipher+leancrypto wasm module `leancrypto_wasm.py`/`sqlite_engine.py` load. Not built from source in this repo.
- `creds/` — local, gitignored credential files. Never commit these. Never run a command against a real one yourself — hand it to the user to run.
- `worker/` — the Cloudflare Worker implementing docs/auth.md and docs/sharing.md, one module per concern:
  - `firebaseAuth.ts` — RS256/JWKS verification of a Firebase ID token, cached per the response's own `Cache-Control`.
  - `auth.ts` — bearer-token extraction + `verifiedUid` for `/v1/keys` and the administrator-only share-management endpoints.
  - `ctl.ts` — the `ctl` join (docs/auth.md §2) over the libsql HTTP `/v2/pipeline` protocol.
  - `cache.ts` — the versioned `keys:v3:{uid}` KV cache and per-uid endpoint rate limits (docs/auth.md §6).
  - `account.ts` — `getAccount`, applying the keys rate limit before resolving an account through cache → `ctl.ts`; used by `/v1/keys` and authenticated share management, never by `/v1/r2-token`.
  - `keys.ts` — `POST /v1/keys`.
  - `r2Ticket.ts` — issues and verifies 24-hour Worker-signed account/path/signing-key tickets.
  - `r2Token.ts` — `POST /v1/r2-token`: verifies a ticket plus P-521 proof and locally signs exact-`db_path` and `{db_prefix}/*` R2 credentials from one parent R2 key pair. The prefix is read-only for ordinary users and read-write for the configured administrator.
  - `share.ts` — administrator-only share registration/deletion plus anonymous shared-content reads, with opaque path grants and a D1 live-share registry.
  - `migrations/` — D1 schema files applied through Wrangler; `0001_share_registry.sql` is the authoritative registry schema.
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
- Docs (this file, README, docs/*) describe current behavior and supported migration inputs only — no commit hashes or narrated development history.
