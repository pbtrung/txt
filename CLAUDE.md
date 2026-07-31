# CLAUDE.md

Context for working in this repository.

## What this is

`txt` is a private, end-to-end encrypted reading vault: one SQLCipher-encrypted SQLite database per user, itself persisted page-by-page in an [rqlite](https://rqlite.io) page store. The two schemas — and the reasoning behind every design choice in them — are documented in [docs/data_model.md](docs/data_model.md); the shared blob format (`magic||version||salt||ciphertext||tag`, AEAD + HKDF) is in [docs/crypto.md](docs/crypto.md). Read both before touching schema or crypto code — they carry the actual design rationale, not just the shape.

`txt.ts`/`txt/` is the admin CLI for this design: `--migrate` brings an existing vault database onto this schema, `--clean-bucket`/`--collect-garbage`/`--vacuum` are day-to-day maintenance of the page store and object storage; see [README.md](README.md) for usage. `ui/` is the browser frontend end users actually read with — see its own section below. `sqlcipher/` is a vendored, prebuilt SQLCipher+leancrypto WASM bundle (not source you edit directly — see below), used by both.

## Working in this repo

- **No build step.** TypeScript runs directly via Node's native type-stripping (Node 22.6+, developed against Node 26). Import specifiers must use the real on-disk extension (`.ts`, not `.js`) for local files — `allowImportingTsExtensions` is on in `tsconfig.json` for exactly this; Node does not remap `.js` specifiers to sibling `.ts` files the way a bundler would.
- **`erasableSyntaxOnly` is on.** No parameter properties (`constructor(private x: T)`), no enums, no namespaces — anything that would require real runtime code to implement a type-only construct. Declare fields explicitly and assign them in the constructor body instead.
- **Functions/methods stay small — a de facto ≤15-line convention** established throughout `txt/`. Split into small private helpers rather than writing one long method.
- **Classes and interfaces, not ad hoc objects/functions**, are the standard shape for anything with state (`SqliteDb`, `BlobCipher`, `OldVault`, `UserDb`, `RqliteDb`, `R2Client`, `MigrateCommand`, ...) — follow the existing module layout in `txt/` rather than introducing a different style.
- **Run `npx prettier --write <files>` before committing** anything under `txt/`, `ui/`, or the root config files. `sqlcipher/` and `docs/` are intentionally excluded (see `.prettierignore`) — don't reformat them.
- **`npx tsc --noEmit` must pass** for `txt/`; **`npm run ui:typecheck`** (`tsc -b ui/tsconfig.json`) must pass for `ui/` — before committing either.
- Commit in small, working increments (one module or one logical change at a time), each verified before moving on — see recent git log for the pattern. Use the `/commit` slash command's convention: detailed message explaining what changed and why, **no AI attribution/co-author trailers**, push after committing.

## Verifying changes for real

Don't just typecheck — this codebase's crypto and SQLite wrapper code has all been verified by actually running it (see git log messages for what was checked at each step). When touching `txt/wasm.ts`, `sqlite.ts`, `blobCipher.ts`, `oldVault.ts`, `userDb.ts`, or `rqliteDb.ts`, write a throwaway script (or extend `txt/migrate.test.ts`) that exercises the real code path — decrypt something, round-trip a blob, open a real database — rather than trusting that types line up. `npm test` runs the committed end-to-end test (synthetic vault + local mock R2 server); it's fast and safe to run freely.

The same applies to `ui/`'s equivalents (`ui/src/data/wasmLoader.ts`, `sqliteDb.ts`, `remoteVfs.ts`, `dbWorker.ts`) — their own tests build a real SQLCipher database and drive real WASM calls, not mocks (see `ui/src/data/remoteVfs.test.ts`/`dbWorker.test.ts`). One thing unit tests genuinely can't cover there: anything that only breaks in a _real browser_, not Node/jsdom. That's exactly how the Worker-based architecture below got found in the first place — a real headless-Chromium check (`npm run ui:test:e2e`, `ui/src/smoke.e2e.test.ts`) caught `Atomics.wait` throwing on the main thread when every mocked/jsdom-based test still passed. Re-run it after touching anything in that call chain (`dbWorker.ts`, `remoteVfs.ts`, `remotePageWorker.ts`/`remotePageClient.ts`, `wasmLoader.ts`) — it needs a real Chromium binary at `/usr/bin/chromium` (hardcoded in the test; adjust if that path doesn't exist locally).

**Never run `--migrate` (or any script) against the real `turso_txt.db` / `creds/*.json` / `in_creds.json` / `out_creds.json` in this repo, and never make real network calls to the live R2 bucket they point at.** Those are real production credentials and a real production data dump kept here for reference/debugging, not fixtures. All of `creds/`, `*.db`, and `*.json` (except the tracked exceptions below) are gitignored for this reason — don't force-add them, and don't paste their contents into commits, docs, or chat.

## sqlcipher/ (vendored WASM bundle)

`sqlcipher.js`/`.wasm` is a prebuilt Emscripten module exporting the raw SQLite/SQLCipher C API, leancrypto's `lc_wasm_*` AEAD/HKDF wrappers, and (as of the current build) `Module.addFunction`/table growth plus a `sqlite3_js_vfs_register` bridge. `js-vfs.mjs`'s `registerJsVfs()` is a complete, tested, JS-implemented `sqlite3_vfs` built on that bridge (`test-js-vfs.mjs` verifies it, including SQLCipher layered on top). `txt/userDb.ts` uses it to build a temporary user database entirely in memory.

These are build **outputs**, not sources — there's no build script for this exact bundle in this repo (only a sibling, unrelated leancrypto-only build script exists at `~/work/secbits/leancrypto/build-wasm.sh`; it does not produce this artifact). If `sqlcipher.js`/`.wasm`/`.symbols` ever need to change, that's a rebuild task with its own scope, not a small edit — don't hand-edit the `.js`/`.wasm` files.

Both `.js`/`.mjs` files are untyped from TypeScript's perspective; `sqlcipher.d.ts` and `js-vfs.d.mts` are hand-written sibling declarations (note the CJS-vs-ESM distinction: `sqlcipher.js` is CommonJS per its own `package.json`, so its `.d.ts` uses `export =`; `js-vfs.mjs` is a real ES module, so its `.d.mts` uses a normal named export). Extend these declarations if a module needs another export from the WASM module — don't reach for `any` casts at call sites instead.

## ui/ (browser frontend)

The React/Vite app end users actually read documents with. Uses the same root `package.json`/`node_modules` as `txt/` — no `ui/package.json`, no npm workspaces — via `npm run ui:dev`/`ui:build`/`ui:typecheck`/`ui:test`/`ui:test:e2e` (see root `package.json`). `ui/vite.config.ts` sets `root: UI_DIR` explicitly since it's invoked with `--config ui/vite.config.ts` from the repo root, not from inside `ui/` itself.

Unlike `txt/`, which reads a user's whole database into memory at once, `ui/` opens it lazily and read-write, directly against a live `docker/` deployment:

- **`data/dbWorker.ts`** owns the real `SqliteDb`/lazy VFS (`data/remoteVfs.ts`) — and it _has to_: a real browser throws `TypeError: Atomics.wait cannot be called in this context` if `Atomics.wait` runs on the main/document thread (Node has no such restriction, which is why this wasn't caught until a real-browser check existed — see "Verifying changes for real" above), and `remoteVfs.ts`'s `xRead` needs exactly that to bridge SQLite's synchronous WASM callback to an async `READ_PAGE` fetch. So the whole SQLite/VFS/commit layer lives inside a Worker, which itself spawns `data/remotePageWorker.ts` (the actual page-fetch worker) as a _nested_ Worker — workers can spawn their own sub-workers, so `Atomics.wait` is legal there.
- **`state/VaultContext.tsx`** (and `screens/Reader/useReaderBook.ts`) never touch `SqliteDb` directly — they talk to `data/dbWorkerClient.ts`, a small RPC client (`postMessage`/`onmessage`, request-id correlation) that's the _only_ thing allowed to talk to the worker. Every write (bookmarks, read position) is serialized inside `dbWorker.ts` itself (one promise-chained queue), not on the main thread.
- **`data/wasmLoader.ts`** loads `sqlcipher/sqlcipher.js` identically on the main thread and inside a Worker: `fetch()` the real bytes, verify their SHA-512 against a build-time-baked hash (`vite.config.ts`'s `define`) ourselves, then `import()` the verified UMD source (with `export default Sqlite3Wasm;` appended — its own tail already leaves that as a plain top-level `var`) from a `blob:` URL as a real ES module. No `<script>` tag (a Worker has no `document` to hang one off), no `eval()`/`new Function` (would need a broader `unsafe-eval` CSP grant than the `wasm-unsafe-eval` this project actually needs).
- **Two distinct credential shapes, don't confuse them**: `data/creds.ts`'s `Creds` (`{rqlite_url, api_key, user_root_key, r2_config}`) is an end user's own unlock file, loaded client-side via a file `<input>`. `ui/build-creds.json` (gitignored, read by `ui/scripts/build-integrity.mjs`) is a deployment-owned build secret (`asset_base_url`, `rqlite_url`, a managed `slhdsa_256f_priv_key`) — unrelated to any individual user's vault, even though `rqlite_url` reuses `Creds`' own field name for the same concept. `rqlite_url`'s origin backs `dist/_headers`' CSP `connect-src`.
- **`local_index.html`** (written to `creds/local_index.html`, never `dist/`) is meant to be opened from the same cross-origin-isolated origin `docker/nginx.conf`'s port-4002 block serves the rest of `ui/dist/` from, not via a bare `file://` path — `SharedArrayBuffer` (needed for the Worker+`Atomics` bridge above) is unavailable to a page that isn't cross-origin isolated, which `file://` can never be. See `docker/README.md`'s "Serving `ui/`" section.
- No admin Manage screen (user/document management, sharing) — deliberately out of scope for now; don't add it without being asked.

## Key facts worth not re-deriving

- This WASM build's SQLCipher requires a **raw** key (`x'<hex>'` literal via `sqlite3_key`) of **at least 256 bytes** — not a passphrase run through PBKDF2. `user_root_key` (base64, ≥256 raw bytes) is used directly as that raw key; see `txt/sqlite.ts`'s `SqliteDb.open`.
- The WASM module has no real-filesystem VFS by default — only MEMFS. Reading an existing host file means preloading its bytes via `Module.FS.writeFile` first (`SqliteDb.open`'s `preload` option); this is separate from the JS-backed `registerJsVfs` VFS used for the _output_ temp database.
- i64 SQLite values (rowids, `sqlite3_bind_int64`/`column_int64`) are real JS `bigint` in this build (compiled with WASM_BIGINT) — not split into hi/lo 32-bit pairs.
- `api_keys.key_hash` is `base64(SHA3-256(raw key))` — not hex. Node's built-in `crypto.createHash('sha3-256')` works directly, no extra dependency needed.
