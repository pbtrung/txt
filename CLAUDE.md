# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repository.

## What this is

A personal document-storage system. One administrator account plus any number of ordinary user accounts, each with its own pair of databases: **AA**, a per-account Turso Cloud (libSQL) database holding a page map, version history, snapshot pins, bundle/library-index pointers, and — inline, as blobs — the SQLCipher ciphertext of every page version; and **BB**, the SQLCipher-keyed SQLite database the application actually opens and issues SQL against, whose pages live nowhere but AA (no local file, no R2/S3 object per page). Document part payloads, bundles, and the library index are the three things that still live as R2/S3 objects, each under its own `{db_prefix}/{t,b,i}/...` prefix. Every sensitive value AA holds — `db_prefix`, `bundle_key`, `object_key`, and the account's own `umk` — is stored wrapped, never as plaintext; only a client that can unwrap `umk` (via `user_root_key`, which never leaves the client) can reconstruct an actual R2/S3 address or open BB. Read `docs/data_model.md`, `docs/auth.md`, and `docs/crypto.md` before making any design-level change — they're the source of truth, not this file.

The account model: `ctl`, an ordinary Turso database in the same organization, maps a Firebase uid to that account's own `db_path` and `type` (`admin` or `user`). Only the administrator account can mint Turso database tokens and create new Turso databases (via the Platform API token in its own creds.json); this repo has no code path that provisions an ordinary user's account end to end — that's `--init-admin`'s creds.json reused with a different uid's row already present in `ctl`.

## Commands

```
python3 txt.py --init-admin <creds.json> [-v|--verbose]
python3 txt.py --init-db <creds.json> [-v|--verbose]
```

Entry point is `txt.py` → `txt/cli.py`'s `cli()` → one of `AdminInitializer` (`admin_init.py`) or `DbInitializer` (`init_db.py`). Both take the same creds.json shape (`Creds` in `creds.py`).

## Architecture map

- `txt/creds.py` — `Creds` dataclass and `load_creds`/`ensure_user_root_key`. Required fields: `turso_org_token`, `turso_ctl_db_url`, `turso_group`, `turso_org`, `firebase_email`, `firebase_password`, `firebase_api_key`. Optional: `display_name`, `user_root_key` — `ensure_user_root_key` fills in a fresh 256-random-byte, base64 value only when empty, writing it back into the source creds.json while preserving every other field, and never overwriting an existing value.
- `txt/firebase_auth.py` — `FirebaseAuth.sign_in`: plain REST call to `identitytoolkit.googleapis.com`'s `accounts:signInWithPassword`, returns the Firebase uid (`localId`).
- `txt/turso_api.py` — `TursoClient`: the Turso Platform API (`create_database`, `mint_db_token`). `extract_db_name(url, account_name)` recovers a database's own name from its `libsql://{name}-{account_name}.../` URL by locating the `-{account_name}.` marker — not by naive splitting, since a name could itself contain a hyphen.
- `txt/libsql_client.py` — `LibsqlClient`: the libSQL/Turso HTTP `/v2/pipeline` API (`execute`, `query`). BLOB arguments and result cells are `{"type": "blob", "base64": ...}`, never raw bytes as `"text"` — confirmed against Turso's own HTTP API reference, not guessed.
- `txt/random_token.py` — `generate_db_path`/`generate_random_prefix` (an alias, same recipe): 32 random bytes rendered as 52 lowercase base32-Crockford characters, used for `ctl.db_path`, `meta.db_prefix`, and `txt.prefix`.
- `sqlcipher/` — a vendored, custom-built `sqlcipher.wasm` (plus its Emscripten JS glue, a `.symbols` export list, and Node test scripts) that statically links leancrypto and configures SQLCipher to use leancrypto's Ascon-Keccak cipher (`PRAGMA cipher == 'ascon-keccak-512'`, confirmed via `test-roundtrip.mjs`). Not built in this repo — treat as a build artifact, tracked in git since there's no build step here to regenerate it. `sqlcipher.js.symbols` is the authoritative list of exported functions when the minified `sqlcipher.js` itself isn't worth reading directly.
- `txt/leancrypto_wasm.py` — `LeancryptoEngine`: hosts `sqlcipher.wasm` directly via `wasmtime`, with no Node/JS glue involved at all. `wasmtime`'s built-in WASI covers the `wasi_snapshot_preview1` imports; Python stubs cover the `env.*` Emscripten imports (filesystem syscalls, date/timezone math, signals) that this crypto-only usage never actually reaches. Wraps `lc_wasm_hkdf_sha3_512`/`lc_wasm_aead_encrypt`/`lc_wasm_aead_decrypt` (Ascon-Keccak AEAD, 64-byte key/nonce/tag) and `lc_kyber_1024_x448_keypair`/`_enc`/`_dec` (the composite ML-KEM-1024 + X448 KEM, `docs/crypto.md`'s Composite KEM Key Sizes) through malloc'd wasm-memory buffers.
- `txt/crypto_blob.py` — `CryptoBlob`: `docs/crypto.md`'s Encrypt/Decrypt blob format (`magic(2) || version(2) || salt(64) || ciphertext || tag(64)`, AD = `magic||version||salt` since `context` isn't implemented yet) on top of `LeancryptoEngine`, plus `encrypt_json`/`decrypt_json` (brotli-compress the JSON payload first).
- `txt/admin_init.py` — `AdminInitializer`: signs into Firebase, ensures `ctl.users` exists, generates a `db_path` and creates that Turso database, inserts the `ctl.users` row (`type = 'admin'`) — idempotent: an existing row for this uid is reported, not recreated.
- `txt/init_db.py` — `DbInitializer`: looks up this uid's `db_path`/`type` in `ctl`, connects directly to that account's own Turso database, ensures the AA schema, establishes `umk` (via `key_store`, every account has one), wraps a freshly generated `db_prefix` under `umk` into `meta`, and wraps `{display_name, db_master_key}` under `umk` into `cred_store`. Every step is check-then-insert — idempotent, safe to rerun.
- `txt/logger.py` — `Logger`: timestamped `verbose`/`info` lines, `verbose` gated on `--verbose`.
- `txt/cli.py` — click-based CLI wiring `--init-admin`/`--init-db`/`--verbose`.
- `txt/tests/` — the pytest suite (below).

## Non-obvious constraints (confirmed empirically — don't re-derive, don't assume otherwise)

- **Hosting `sqlcipher.wasm` directly with `wasmtime` needs two explicit calls Emscripten's own JS runtime normally makes for you**: `__wasm_call_ctors` (static constructors) and `lc_activate_library` (leancrypto's own activation/self-test gate). Skip either and every leancrypto call fails as if the library were never activated — confirmed the hard way (`lc_wasm_aead_encrypt` returning a nonzero rc with otherwise-correct arguments).
- **`lc_seeded_rng` is `extern struct lc_rng_ctx *lc_seeded_rng`** — the wasm module exports it as an immutable `Global` holding the *address* of that pointer variable, not the pointer's current value. Using the KEM keypair functions needs one more dereference: read 4 bytes at that address to get the actual `rng_ctx` pointer to pass in.
- **The `lc_wasm_aead_encrypt`/`lc_wasm_aead_decrypt`/`lc_wasm_hkdf_sha3_512` wrapper functions have no type metadata in the compiled wasm/JS** (11 and 8 raw `i32` params respectively) — their real argument order came from reading `sqlcipher/test-roundtrip.mjs`'s own calls against them, not from guessing a leancrypto-API-conventional order.
- **Turso/libSQL's HTTP pipeline API represents BLOB values as `{"type": "blob", "base64": ...}`**, both as request arguments and in query result cells — not raw bytes under `"value"` the way `text`/`integer` cells work.
- **`PRAGMA page_size` only takes effect on an empty database** — `DbInitializer` sets AA's own page size (32768, matching BB's SQLCipher page size) before any `CREATE TABLE`, since `page_versions.data` holds a full ~32 KiB BB page per row and AA's 4096-byte default would otherwise fragment every such row across roughly eight overflow pages.
- **`umk` is always 128 random bytes, generated once and persisted wrapped by `user_root_key`, never re-derived** — every account (admin or not) has a `key_store` row for exactly this reason; only an admin's `key_store` row also carries the composite KEM keypair (currently unused, kept for a future feature per `docs/crypto.md`).
- **`db_prefix`/`bundle_key`/`object_key` are `BLOB`, wrapped under `umk`** — AA never holds a directly readable R2/S3 address for any object population; only a client that can unwrap `umk` can reconstruct one.
- **This project's Python code follows a `<=15 lines per function`, class-based-reuse convention** — matches the style already in `txt/`; keep new code consistent with it (see `LeancryptoEngine`'s `_call`/`_free_all`/`_write`/`_read` helpers for the pattern of factoring out repeated malloc/free/error-check boilerplate).

## Verification

`txt/tests/` is a real pytest suite (`pytest txt/tests/`, or `pip install -e ".[dev]"` first). Follows this project's real-building-blocks philosophy: `test_leancrypto_wasm.py` and `test_crypto_blob.py` run against the actual `wasmtime`-hosted leancrypto engine (real AEAD round-trip and tamper-detection checks against ciphertext/aad/tag/wrong-key, a real KEM encapsulate/decapsulate agreement check, real HKDF determinism) rather than mocking the crypto layer; `test_init_db.py` verifies `DbInitializer`'s idempotency and schema-shape decisions against fake Firebase/Turso/libsql clients, using the real crypto engine underneath so wrapped values in test assertions are genuine blobs, not stand-ins.

Not verified by this suite, and not run against real infra by the agent itself (hand real creds.json files to the user instead): the actual Turso Platform API / libSQL HTTP calls, and Firebase sign-in against a real project.

## Commit conventions

Detailed commit messages (imperative subject, bullet-point body explaining what and why), **no AI/Claude attribution ever** (no `🤖 Generated with Claude Code`, no `Co-Authored-By: Claude`), always push after committing. A `/commit` skill (`.claude/commands/commit.md`) automates this.

## Secrets

`.gitignore` blocks all `*.json` (creds.json files carry real Firebase/Turso secrets) and the whole `creds/` directory. Never commit a JSON file containing real credentials; double-check contents before `git add` on anything JSON-shaped.
