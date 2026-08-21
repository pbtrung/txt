# CLAUDE.md

This repo holds the txt document-storage system's design docs, its single-owner OpenResty/rqlite gateway, the browser UI, and the Python maintenance CLI.

## Design docs (read these before touching auth/storage code)

- `docs/auth.md` — Firebase owner authentication, owner tickets, proof-of-possession, and the `/v1/keys` and `/v1/r2-token` APIs.
- `docs/data_model.md` — the owner's SQLCipher database (`txt`/`txt_bookmarks`) schema and its conditional read-write round trip against R2.
- `docs/storage_layout.md` — the R2 object-key layout the owner database and per-document content live under.
- `docs/sharing.md` — public sharing, capability URLs, and presigned R2 reads.
- `docs/crypto.md` — the AEAD/HKDF/KEM primitives (Ascon-Keccak, HKDF-SHA3-512, ML-KEM-1024+X448) and the blob format used by `owner_control` and encrypted EPUB copies.
- `docs/deployment.md` — the Northflank container, rqlite persistence and R2 backups, gateway environment, and Cloudflare Pages UI deployment.

## Code layout

- `txt.py` — thin entry point; also runnable as the installed `txt` console script.
- `txt/` — one module per concern:
  - `creds.py` — loads the exact rqlite `OwnerCreds` file, loads Turso-source credentials for migration/maintenance, and generates `user_root_key` when empty.
  - `logger.py` — `--verbose` progress logging.
  - `firebase_auth.py` — Firebase email/password sign-in, returns the uid.
  - `turso_api.py` and `libsql_client.py` — source-control adapters used to read and validate the Turso owner during `--migrate`, its only remaining consumer.
  - `rqlite_client.py` — Basic-auth client for the external OpenResty operator route, including named parameters, BLOB arrays, transactional batches, and a dedicated non-transactional `vacuum()` (SQLite forbids `VACUUM` inside a transaction).
  - `rqlite_schema.py` — idempotent schema-v1 statements installed automatically when owner initialization reaches an empty rqlite database.
  - `rqlite_updater.py` — `RqliteUpdater`, the `--update-rql` implementation: applies every `docker/migrations/NNNN_*.sql` file not yet recorded in `schema_migrations` to an already-provisioned instance, in order, then vacuums.
  - `random_token.py` — base32-Crockford encoding, used for `db_path`/`db_prefix`/per-document key segments.
  - `leancrypto_wasm.py` — wasmtime binding to `sqlcipher/sqlcipher.wasm`'s bundled leancrypto build (AEAD, HKDF, KEM).
  - `crypto_blob.py` — docs/crypto.md's wrap/unwrap blob format, built on `leancrypto_wasm`.
  - `sqlite_engine.py` — real SQLCipher read/write against `sqlcipher.wasm`: an in-memory `sqlite3_vfs` (function pointers installed into the wasm indirect function table via `sqlite3_js_vfs_register`) backs the whole database in a Python `bytearray`, since this build has no working native filesystem VFS and `:memory:` connections never engage the codec. Keys are 256–8192 raw bytes (`sqlite3_key`), not a passphrase.
  - `owner_init.py` — `OwnerInitializer`, the idempotent `--init-owner` implementation. It installs an absent rqlite schema, creates exactly one `owner_control` row, and validates existing owner material. Its `load_current_owner()` (sign in, read the singleton row, validate, decrypt) is the shared entry point `ingest.py`, `db_updater.py`, and `bucket_cleaner.py` reuse to reach the owner's account.
  - `turso_migration.py` — `OwnerMigrator`, the `--migrate TURSO_CREDS_JSON RQLITE_CREDS_JSON` implementation. It validates the source owner, preserves the credential payload, creates fresh destination keys when needed, and supports a write-free `--dry-run`.
  - `r2_client.py` — `R2Client`, a thin boto3/S3-compatible wrapper for R2 (get/put object, list keys, list common prefixes, delete keys).
  - `opf.py` — Calibre `.opf` sidecar detection and `<metadata>` parsing; `ingest.py` extracts just `title`/`authors`/`subjects`/`publisher` from it into `txt.catalog` (docs/data_model.md §2.1).
  - `ingest.py` — `TxtIngester`, the `--ingest` command: uploads each EPUB in a directory as one R2 object, keeps a resumable local SQLCipher working copy, and dedups against already-recorded filenames.
  - `db_updater.py` — `DbUpdater`, the `--update-db` command: migrates and validates the complete catalog, CFI reading-state, bookmark, share, and named-migration schema for the singleton owner's database. R2 is always the input; local files are inspection checkpoints only.
  - `bucket_cleaner.py` — `BucketCleaner`, the `--clean-bucket` command: deletes R2 objects not referenced by the singleton owner's database, excluding the `{db_prefix}/shared/` namespace (public shares are gateway-owned).
  - `replace_images.py` — `--replace-images`: replaces EPUB images with placeholders and constrains their display size; unrelated to the rest of this package's account/storage logic.
  - `edit_epub.py` — `--edit-epub`: splits EPUB spine items into soft 1.2 MB parts, rewrites title/series metadata and sidecars, then applies the same image replacement rules as `--replace-images`.
  - `cli.py` — the click entry point.
- `txt/tests/` — pytest. Crypto and SQLCipher tests run against the real wasm engine (`txt/tests/conftest.py`'s session-scoped `engine` fixture); everything else fakes only the network boundary (Firebase, Turso/libsql, rqlite, R2) — never the crypto itself.
- `sqlcipher/` — the prebuilt SQLCipher+leancrypto wasm module `leancrypto_wasm.py`/`sqlite_engine.py` load. Not built from source in this repo.
- `creds/` — local, gitignored credential files. Never commit these. Never run a command against a real one yourself — hand it to the user to run.
- `docker/` — the deployable OpenResty and rqlite container. `lua/endpoints/` contains HTTP entry points, `lua/txt/` contains reusable gateway modules, `lua/tests/` contains the dependency-light test suite, and `migrations/` owns the control database schema.
- `ui/src/data/rqlite.ts` — the browser's fixed singleton owner query through the Basic-auth operator proxy; `ui/src/data/apiClient.ts` owns Firebase-authenticated tickets, temporary R2 credentials, and share API calls.
- `ui/tests/` — vitest, mirroring the UI source tree rather than living beside source files.
- `wrangler.jsonc`, `package.json`, `scripts/deploy.sh` — Cloudflare Pages configuration and deployment of the freshly built `dist/` static UI. Wrangler does not run an API service.
- `ui/_headers` — Cloudflare Pages response headers copied into `dist/` by `npm run ui:build`.

## Conventions

- Functions stay ≤15 lines; use a class (not free functions) for anything holding state — a client, an engine, a session.
- Reuse the existing generic pieces (`RqliteClient`, `LibsqlClient`, `TursoClient`, `CryptoBlob`, `FirebaseAuth`, `OwnerInitializer`, `R2Client`, `SqliteEngine`) instead of duplicating HTTP, crypto, or storage logic in a new command.
- UI TypeScript is formatted with Prettier at 88 columns (`.prettierrc.json`); run `npm run format` before committing UI changes. `.prettierignore` excludes generated/vendored files and the Python tree.
- The Python tree is linted and formatted with ruff (`[tool.ruff]` in `pyproject.toml`, 88 columns to match the TS side): `python3 -m ruff check .` and `python3 -m ruff format .` before committing.
- `ui/` is linted with ESLint (`eslint.config.js`): `npm run lint` before committing UI changes.
- OpenResty Lua targets the current LuaJIT language supported by the container. Run `npm run lua:format` and `npm run lua:check` before committing Lua changes.
- The project's own TypeScript is 7.x (`typescript7`, aliased since typescript-eslint doesn't support TS 7 yet); a plain `typescript@6.0.3` devDependency exists solely to satisfy typescript-eslint's own peer range. `npm run tsc` (used by every `*:typecheck`/`ui:build` script) always resolves to the real 7.x compiler, never the 6.x one — the alias exists only so both can coexist under `node_modules` without conflict.
- Docs (this file, README, docs/*) describe current behavior and supported migration inputs only — no commit hashes or narrated development history.
