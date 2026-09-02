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
  - `creds.py` — loads the exact `OwnerCreds` file (Cloudflare account/D1/R2 credentials) and generates `user_root_key` when empty.
  - `logger.py` — `--verbose` progress logging.
  - `d1_client.py` — `D1Client`, a thin HTTP client for Cloudflare's D1 query API (`docs/data_model.md`), used directly by this batch tool rather than the Worker's ticket/proof-gated endpoints. D1's params array accepts only strings, so BLOB values are hex-encoded and paired with `unhex(?)` at the call site; a BLOB column read back from a `SELECT` arrives as a plain JSON array of byte values instead.
  - `account_data.py` — `parse_owner_account()` validates and parses the owner's decrypted `encrypted_credentials` payload (`{user_handle, display_name, db_prefix}`) into an `OwnerAccount`.
  - `random_token.py` — base32-Crockford encoding, used for `db_prefix`/per-document key segments.
  - `leancrypto_wasm.py` — wasmtime binding to `sqlcipher/sqlcipher.wasm`'s bundled leancrypto build (AEAD, HKDF, KEM).
  - `crypto_blob.py` — docs/crypto.md's wrap/unwrap blob format, built on `leancrypto_wasm`.
  - `sqlite_engine.py` — real SQLCipher read/write against `sqlcipher.wasm`, used only by `db_updater.py`/`bucket_cleaner.py`/`db_cleaner.py` (below) — an in-memory `sqlite3_vfs` (function pointers installed into the wasm indirect function table via `sqlite3_js_vfs_register`) backs a whole database in a Python `bytearray`, since this build has no working native filesystem VFS and `:memory:` connections never engage the codec. Keys are 256–8192 raw bytes (`sqlite3_key`), not a passphrase.
  - `owner_init.py` — `OwnerInitializer`, the idempotent `--init-owner` implementation. It creates exactly one D1 `owner` row and validates existing owner material against `creds.owner_email`/`user_root_key`; the schema itself is Worker-managed (`wrangler d1 migrations`), not installed by this tool. Its `load_current_owner()` (read the singleton row, validate, decrypt) is the shared entry point `ingest.py` reuses to reach the owner's account and `umk`.
  - `r2_client.py` — `R2Client`, a thin boto3/S3-compatible wrapper for R2 (get/put objects, list keys, and delete key batches with partial-failure detection).
  - `opf.py` — Calibre `.opf` sidecar detection and `<metadata>` parsing; `ingest.py` extracts just `title`/`authors`/`subjects`/`publisher` from it into each catalog entry (docs/data_model.md §2.1).
  - `catalog_writer.py` — `DocumentStore`/`CatalogWriter`, the generic D1+R2 write logic shared by `ingest.py` and `migrate_rql.py`: minting `key_store` rows, inserting a `documents`/`bookmarks` row (rolling its own `key_store` rows back if the insert fails), and merging/publishing the singleton R2-hosted catalog object. Takes already-read bytes/fields — no filesystem or source-format knowledge.
  - `ingest.py` — `TxtIngester`, the `--ingest` command: uploads each new EPUB in a directory as one R2 object and writes its `documents`/`key_store` rows directly to D1 via `catalog_writer.py`, then reconciles the R2-hosted catalog object. A local JSON checkpoint (`{db_prefix}.ingest-checkpoint.json` in `--local-db-dir`) records `{filename: document_id}` so a run interrupted between the D1 write and the catalog rewrite resumes cleanly; the catalog itself is also checked by filename first, so a lost checkpoint can't cause a silently-skipped catalog entry.
  - `rqlite_client.py`, `firebase_auth.py` — the predecessor design's rqlite HTTP client and Firebase sign-in (docs and code on the `master` branch), reintroduced only so `migrate_rql.py` can read a not-yet-migrated deployment's owner_control row. Unused by anything targeting the current D1 design.
  - `migrate_rql.py` — `RqlMigrator`, the `--migrate-rql` command: imports one owner's rqlite-hosted `owner_control` row and whole R2-hosted SQLCipher database into a provisioned D1 owner, via `catalog_writer.py`. A local JSON checkpoint (`{db_prefix}.migrate-checkpoint.json` in `--local-db-dir`) records `{old txt.id: {document_id, bookmarks_done}}` so a run interrupted between a document's insert and its bookmarks resumes cleanly; `--limit` bounds how many not-yet-migrated documents one run imports. Does not migrate active public shares (`txt_shares`) — scoped out, since an existing share URL's capability and content key must keep working unchanged.
  - `db_updater.py`, `bucket_cleaner.py`, `db_cleaner.py` — `--update-db`, `--clean-bucket`, `--clean-db`: still target the design's predecessor (rqlite, a whole downloaded SQLCipher database file) and aren't reachable from `cli.py` until they're rewritten for the D1 design (`docs/milestones.md` Milestone 9); their tests skip themselves at import time until then.
  - `replace_images.py` — `--replace-images`: replaces EPUB images with placeholders and constrains their display size; unrelated to the rest of this package's account/storage logic.
  - `edit_epub.py` — `--edit-epub`: splits EPUB spine items into soft 1.2 MB parts, rewrites title/series metadata and sidecars, then applies the same image replacement rules as `--replace-images`.
  - `cli.py` — the click entry point; wires only the commands above that currently work against the D1 design.
- `txt/tests/` — pytest. Crypto and SQLCipher tests run against the real wasm engine (`txt/tests/conftest.py`'s session-scoped `engine` fixture); everything else fakes only the network boundary (D1, R2) — never the crypto itself.
- `sqlcipher/` — the prebuilt SQLCipher+leancrypto wasm module `leancrypto_wasm.py`/`sqlite_engine.py` load. Not built from source in this repo.
- `creds/` — local, gitignored credential files. Never commit these. Never run a command against a real one yourself — hand it to the user to run.
- `ui/src/data/apiClient.ts` — the browser's REST client for `/v1/*`: same-origin `fetch()` (Cloudflare Access supplies the session cookie), owner-proof headers on every mutating call, and Access-challenge detection (`AccessRequiredError`). `ownerProof.ts` builds and signs the canonical proof bytes; `session.ts` unwraps the owner's keys from `GET /v1/owner`'s response; `libraryStore.ts` fetches and decrypts documents/catalog/bookmarks and holds the reactive session-lifetime state that replaces the old local database file; `r2.ts`/`r2Session.ts` hold the two scoped, refreshing R2 credentials; `shares.ts`/`sharedReader.ts` implement the owner and recipient sides of public sharing.
- `ui/tests/` — vitest, mirroring the UI source tree rather than living beside source files.
- `wrangler.jsonc`, `package.json`, `scripts/deploy.sh` — the Worker's deployment config: one Worker serving `/v1/*` and `dist/` together, with D1 and R2 bindings. `scripts/deploy.sh` resolves or creates the production D1 database and R2 bucket by name, applies pending D1 migrations, then deploys (`docs/deployment.md`).
- `ui/_headers` — response headers copied into `dist/` by `npm run ui:build`.

## Conventions

- Functions stay ≤15 lines; use a class (not free functions) for anything holding state — a client, an engine, a session.
- Reuse the existing generic pieces (`D1Client`, `CryptoBlob`, `OwnerInitializer`, `R2Client`, `SqliteEngine`) instead of duplicating HTTP, crypto, or storage logic in a new command.
- UI TypeScript is formatted with Prettier at 88 columns (`.prettierrc.json`); run `npm run format` before committing UI changes. `.prettierignore` excludes generated/vendored files and the Python tree.
- The Python tree is linted and formatted with ruff (`[tool.ruff]` in `pyproject.toml`, 88 columns to match the TS side): `python3 -m ruff check .` and `python3 -m ruff format .` before committing.
- `ui/` is linted with ESLint (`eslint.config.js`): `npm run lint` before committing UI changes.
- The project's own TypeScript is 7.x (`typescript7`, aliased since typescript-eslint doesn't support TS 7 yet); a plain `typescript@6.0.3` devDependency exists solely to satisfy typescript-eslint's own peer range. `npm run tsc` (used by every `*:typecheck`/`ui:build` script) always resolves to the real 7.x compiler, never the 6.x one — the alias exists only so both can coexist under `node_modules` without conflict.
- Docs (this file, README, docs/*) describe current behavior and supported migration inputs only — no commit hashes or narrated development history.
