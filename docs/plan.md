# Frontend + Worker — Progress

Tracks `worker/` (a Cloudflare Worker implementing docs/auth.md) and `ui/` (the Unlock/Library/Reader frontend) against the build order they were planned in. Read docs/auth.md, docs/data_model.md, and docs/crypto.md for the design those pieces implement; this file only tracks what's built versus what's still open.

## Done

### `worker/`

- **`/v1/db-token`** (docs/auth.md §4/§5): Firebase ID token → ctl lookup → short-lived Turso database token, through the KV cache (`token:{uid}` 55m, `user:{uid}` 24h) and per-uid rate limit (§6) docs/auth.md describes.
- **`/v1/r2-token`**: mints a short-lived R2 (S3-compatible) temporary credential via Cloudflare's local-signing JWT scheme (`worker/r2Token.ts`) — bucket-wide read-write for the admin account, read-only scoped to the caller's own `db_prefix` for an ordinary user. Replaces the original plan's static read-only R2 credential shipped in the client's own creds.json.
- `worker/ctl.ts` now returns `{dbPath, type}` (not just `dbPath`) since `type` decides the R2 credential's scope; `worker/cache.ts`'s account cache grew to match; `worker/auth.ts` factors the shared bearer-token/Firebase-verification step both endpoints use.
- Firebase ID token verification (`worker/firebaseAuth.ts`): RS256 against Google's JWKS, cached per response `Cache-Control`.
- 39 tests, real crypto/JWT verification where it matters (no mocked signature checks), fakes only for `fetch`.

### `ui/`

- **Scaffold**: Vite + React 19 + TypeScript + react-router-dom v7, single bundled chunk (`codeSplitting: false` — a prior cross-chunk dynamic-import bug this avoids), routes for `/`, `/library`, `/read/:txtId` guarded by `VaultContext`'s unlock state. No Manage route (out of scope).
- **Crypto layer** (`ui/src/crypto/`): `sqlcipher.wasm` hosted in-browser via its Emscripten glue (classic `<script>` tag with SRI in the browser, dynamic `import()` under Node/Vitest); `aead.ts` wraps the raw HKDF/AEAD exports; `cryptoBlob.ts` ports `docs/crypto.md`'s blob format exactly, including JSON variants; `brotli.ts` bridges Compression/DecompressionStream (browser) and `node:zlib` (tests).
- **AA data layer** (`ui/src/data/`): `libsql.ts` (the HTTP `/v2/pipeline` client, matching `txt/libsql_client.py`'s wire format including BLOB/integer cell handling), `session.ts` (the full key-unwrap chain: `user_root_key` → `umk` → `db_prefix`/`cred_store`/library-index keys/bundle keys), `creds.ts` (the browser's reduced creds.json shape — no Turso org token, no R2 access keys, just Firebase creds + `user_root_key` + non-secret R2 endpoint/region/bucket), `r2.ts` (SigV4 signing via `aws4fetch`, credential minted by the Worker).
- **Unlock screen**: file-picker → Firebase sign-in → Worker `/v1/db-token` → AA connect → key-unwrap chain → Worker `/v1/r2-token` → library index + bundle fetch/decrypt, with phase progress and error display. Session held in memory only (`VaultContext`), never persisted.
- **Library screen**: `doc`/`term`/`doc_term` read via `ui/src/data/sqlite.ts` — sqlcipher.wasm used **unkeyed** (SQLCipher is a superset of SQLite; no key means a plain SQLite file), so no separate `sql.js` dependency. Search, sort, and browse-by-author/subject/publisher ported from the historical `libraryModel.ts`; recency/"in progress" was **not** ported, since that data (`txt_access`) only exists once BB is open, which Library deliberately never does (docs/data_model.md §8.2).
- **Reader screen — opening BB** (docs/data_model.md §6.1):
  - `bundleFormat.ts` parses a bundle's plaintext bytes (header/page-map/hot-pages/index) — the first reader for a format only `txt/bundle.py`'s builder previously wrote.
  - `pageVersions.ts` reads `head_version`, pins a snapshot, and resolves the live page map either from the bundle + an AA delta (pages changed/deleted since `built_at_version`) or a full scan when there's no bundle yet.
  - `jsVfs.ts` is a direct TypeScript port of `sqlcipher/js-vfs.mjs` (the JS-backed `sqlite3_vfs` `txt/bb_engine.py` was itself ported *from*, to Emscripten's `addFunction` instead of wasmtime's table manipulation).
  - `bbEngine.ts` opens BB (keyed with `db_master_key`, loaded with every live page's bytes — a partial page set fails as a malformed database, not a decrypt error) and exposes `query`/`execute`/`drainDirtyPages`.
  - `openReaderBB.ts` orchestrates all of the above, correctly re-fetching a hot page from AA when the delta shows its cached bundle version has been superseded (keyed by `pageNo:versionCreated`, not `pageNo` alone — a real bug caught by its own test).
  - `document.ts` reads `txt`/`txt_meta`/`txt_parts` for a given id, decoding `prefix`/`path` via a from-scratch `base32Crockford.ts` port (cross-checked byte-for-byte against `txt/random_token.py`'s real output).
  - The screen itself opens BB and shows the document's name/part count — real EPUB rendering is not built yet (see below).
- 107 tests, real wasm/crypto/SQLite throughout (genuine encrypted blobs, genuine SQLite files built via `sqlite3_exec`, a real open→write→drain-pages→reopen BB round trip); screens themselves mock at the data-hook boundary (`useVault`, `useLibraryBooks`, `useReaderDocument`), matching this project's stated testing philosophy.
- Found and fixed two real bugs along the way: a root-`package.json` `"type": "module"` addition silently broke `sqlcipher/test-roundtrip.mjs`'s Node module resolution (fixed with a scoped `sqlcipher/package.json`), and `isBrowser()` returned `true` under Vitest's jsdom environment (which never executes injected `<script>` tags), hanging any jsdom test that touched the wasm loader.

## Not yet implemented

- **Reader screen — EPUB rendering.** Fetching + decrypting a document's parts from R2 (`{db_prefix}/t/{prefix}/{path}`, keyed by `txt.txt_key`), concatenating them in `part_num` order, and handing the result to `epubjs`'s `ePub(arrayBuffer)`. No prev/next/TOC UI yet. Read-position persistence (`txt_access`, debounced flush to AA per docs/data_model.md §7.1) is part of this step, not yet started — `bbEngine.ts`'s `execute`/`drainDirtyPages` exist already but have no caller for a real write yet.
- **Docs + cleanup pass.** `CLAUDE.md`/`README.md` don't describe `worker/`/`ui/` yet. No sweep for dead code/unused files/the ≤15-line-function convention across the new code has been done as its own pass (each step was written to the convention as it went, but nothing has re-checked the whole tree together).
- **Snapshot heartbeating.** `pageVersions.ts`'s `pinSnapshot` inserts a `snapshots` row once at BB-open time but never heartbeats it (docs/data_model.md's 30s interval). A snapshot with a stale heartbeat becomes eligible for cleanup, which could let `--collect-garbage` reclaim pages a long-lived Reader session still has open. Low risk for a single-admin personal project, but a real gap if a reader session outlives ~90 seconds while GC runs concurrently.
- **R2 credential refresh.** `R2Client`'s credential is a snapshot from `/v1/r2-token` (900s TTL) taken once at Unlock; nothing refreshes it if a session outlives that window. Not exercised yet since nothing does long-running R2 reads across that boundary today.
- **Real infrastructure has not been exercised.** No agent-run test has hit real Firebase, real Turso, a real deployed Worker, or a real R2 bucket — per this project's standing rule, that's for the user to verify with real credentials.
