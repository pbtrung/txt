# CLAUDE.md

This repo holds the txt document-storage system's design docs, a single-owner Cloudflare Worker/D1/R2/Access application, the browser UI, and the Python maintenance CLI.

## Design docs (read these before touching auth/storage code)

- `docs/auth.md` — Cloudflare Access owner authentication, the owner binding ticket, proof-of-possession (now required on every D1-mutating endpoint, not only R2 credential minting), and rate limiting.
- `docs/data_model.md` — the owner's D1 schema (`owner`, `key_store`, `catalog`, `documents`, `bookmarks`, `shares`), its per-row encryption model, and its optimistic-concurrency read/write model.
- `docs/storage_layout.md` — the R2 object-key layout documents, shared copies, and the catalog object live under.
- `docs/sharing.md` — public sharing, capability URLs, and presigned R2 reads.
- `docs/crypto.md` — the AEAD/HKDF/KEM primitives (Ascon-Keccak, HKDF-SHA3-512, ML-KEM-1024+X448) and the blob format used by `owner`/`key_store` and row-level D1 data, plus the separate native Web Crypto (AES-256-GCM/HKDF-SHA-256) scheme used only for shared EPUB content.
- `docs/deployment.md` — the Worker, D1, R2, and Access configuration and release verification.

## Code layout

- `txt.py` — thin entry point; also runnable as the installed `txt` console script.
- `txt/` — one module per concern:
  - `creds.py` — loads the exact rqlite `OwnerCreds` file and generates `user_root_key` when empty.
  - `logger.py` — `--verbose` progress logging.
  - `firebase_auth.py` — Firebase email/password sign-in, returns the uid.
  - `rqlite_client.py` — Basic-auth client for the external OpenResty operator route, including named parameters, BLOB arrays, transactional batches, and a dedicated non-transactional `vacuum()` (SQLite forbids `VACUUM` inside a transaction).
  - `rqlite_schema.py` — the idempotent current-schema snapshot installed automatically when owner initialization reaches an empty rqlite database, including migration markers for every change represented by the snapshot.
  - `rqlite_updater.py` — `RqliteUpdater`, the `--update-rql` implementation: applies every migration file not yet recorded in `schema_migrations` to an already-provisioned instance, in order, then vacuums. Targets rqlite; pending the D1 rewrite in `docs/milestones.md`.
  - `random_token.py` — base32-Crockford encoding, used for `db_path`/`db_prefix`/per-document key segments.
  - `leancrypto_wasm.py` — wasmtime binding to `sqlcipher/sqlcipher.wasm`'s bundled leancrypto build (AEAD, HKDF, KEM).
  - `crypto_blob.py` — docs/crypto.md's wrap/unwrap blob format, built on `leancrypto_wasm`.
  - `sqlite_engine.py` — real SQLCipher read/write against `sqlcipher.wasm`: an in-memory `sqlite3_vfs` (function pointers installed into the wasm indirect function table via `sqlite3_js_vfs_register`) backs the whole database in a Python `bytearray`, since this build has no working native filesystem VFS and `:memory:` connections never engage the codec. Keys are 256–8192 raw bytes (`sqlite3_key`), not a passphrase.
  - `owner_init.py` — `OwnerInitializer`, the idempotent `--init-owner` implementation. It installs an absent rqlite schema, creates exactly one `owner_control` row, and validates existing owner material. Its `load_current_owner()` (sign in, read the singleton row, validate, decrypt) is the shared entry point `ingest.py`, `db_updater.py`, `bucket_cleaner.py`, and `db_cleaner.py` reuse to reach the owner's account.
  - `r2_client.py` — `R2Client`, a thin boto3/S3-compatible wrapper for R2 (get/put objects, list keys, and delete key batches with partial-failure detection).
  - `opf.py` — Calibre `.opf` sidecar detection and `<metadata>` parsing; `ingest.py` extracts just `title`/`authors`/`subjects`/`publisher` from it into `txt.catalog` (docs/data_model.md §2.1).
  - `ingest.py` — `TxtIngester`, the `--ingest` command: uploads each EPUB in a directory as one R2 object, writes a local SQLCipher inspection checkpoint, and dedups against filenames in the current R2 database. R2 is always the input source.
  - `db_updater.py` — `DbUpdater`, the `--update-db` command: migrates and validates the complete catalog, CFI reading-state, bookmark, share, and named-migration schema for the singleton owner's database. R2 is always the input; local files are inspection checkpoints only.
  - `bucket_cleaner.py` — `BucketCleaner`, the `--clean-bucket` command: deletes R2 objects not referenced by the singleton owner's database, excluding the `{db_prefix}/shared/` namespace (public shares are gateway-owned) and the server-only prefix configured by `rqlite_control_backup`.
  - `db_cleaner.py` — `DbCleaner`, the `--clean-db` command: removes stale (`creating`/`deleting`) `txt_shares`/`shares` rows from the owner's SQLCipher database and the rqlite control database, healing a `creating` row back to `active` if it actually registered, then vacuums both databases unconditionally regardless of `--dry-run`.
  - `replace_images.py` — `--replace-images`: replaces EPUB images with placeholders and constrains their display size; unrelated to the rest of this package's account/storage logic.
  - `edit_epub.py` — `--edit-epub`: splits EPUB spine items into soft 1.2 MB parts, rewrites title/series metadata and sidecars, then applies the same image replacement rules as `--replace-images`.
  - `cli.py` — the click entry point.
- `txt/tests/` — pytest. Crypto and SQLCipher tests run against the real wasm engine (`txt/tests/conftest.py`'s session-scoped `engine` fixture); everything else fakes only the network boundary (Firebase, rqlite, R2) — never the crypto itself.
- `sqlcipher/` — the prebuilt SQLCipher+leancrypto wasm module `leancrypto_wasm.py`/`sqlite_engine.py` load. Not built from source in this repo.
- `creds/` — local, gitignored credential files. Never commit these. Never run a command against a real one yourself — hand it to the user to run.
- `ui/src/data/rqlite.ts` — the browser's fixed singleton owner query through the Basic-auth operator proxy; `ui/src/data/apiClient.ts` owns Firebase-authenticated tickets, temporary R2 credentials, and share API calls. Both target the rqlite/Firebase design; pending the Worker/Access rewrite in `docs/milestones.md`.
- `ui/tests/` — vitest, mirroring the UI source tree rather than living beside source files.
- `wrangler.jsonc`, `package.json`, `scripts/deploy.sh` — still Cloudflare Pages configuration and deployment of the freshly built `dist/` static UI, pending Milestone 0 in `docs/milestones.md` (one Worker serving `/v1/*` and `dist/` together, with D1 and R2 bindings, replacing the Pages-only config).
- `ui/_headers` — Cloudflare Pages response headers copied into `dist/` by `npm run ui:build`.

## Conventions

- Functions stay ≤15 lines; use a class (not free functions) for anything holding state — a client, an engine, a session.
- Reuse the existing generic pieces (`RqliteClient`, `CryptoBlob`, `FirebaseAuth`, `OwnerInitializer`, `R2Client`, `SqliteEngine`) instead of duplicating HTTP, crypto, or storage logic in a new command.
- UI TypeScript is formatted with Prettier at 88 columns (`.prettierrc.json`); run `npm run format` before committing UI changes. `.prettierignore` excludes generated/vendored files and the Python tree.
- The Python tree is linted and formatted with ruff (`[tool.ruff]` in `pyproject.toml`, 88 columns to match the TS side): `python3 -m ruff check .` and `python3 -m ruff format .` before committing.
- `ui/` is linted with ESLint (`eslint.config.js`): `npm run lint` before committing UI changes.
- The project's own TypeScript is 7.x (`typescript7`, aliased since typescript-eslint doesn't support TS 7 yet); a plain `typescript@6.0.3` devDependency exists solely to satisfy typescript-eslint's own peer range. `npm run tsc` (used by every `*:typecheck`/`ui:build` script) always resolves to the real 7.x compiler, never the 6.x one — the alias exists only so both can coexist under `node_modules` without conflict.
- Docs (this file, README, docs/*) describe current behavior and supported migration inputs only — no commit hashes or narrated development history.
