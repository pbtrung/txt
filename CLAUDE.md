# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repository.

## What this is

A personal document-storage system. The design (`docs/data_model.md`) stores everything in one InstantDB app plus Cloudflare R2: InstantDB holds only `$users` (Firebase-verified identity + a wrapped key hierarchy) and a page-store (`dbMeta`/`pages`/`$files`/`activeReaders`) for **one SQLCipher-encrypted SQLite database per user**, paged remotely into R2 a page at a time. The actual application schema (documents/parts/bookmarks — see `txt/sqlcipherBuilder.ts`'s `SCHEMA_SQL`) lives entirely *inside* that per-user SQLCipher file; InstantDB never sees plaintext rows for it, only opaque client-encrypted page pointers.

This repo is the **TypeScript CLI** (`txt.ts`) for administering that system — not the end-user app itself (no UI here). `--migrate` imports documents from an external SQLite snapshot with its own schema (see `txt/owner.ts`) into an already-`--init-admin`-provisioned InstantDB account, through the same page-by-page R2 transport `--init-admin` itself uses.

Read `docs/data_model.md` (entities, key hierarchy, commit/read protocols, GC) and `docs/crypto.md` (the AEAD/KDF blob format) before making any design-level change — they're the source of truth, not this file.

## Commands

```
node txt.ts --init-admin <creds.json> [-v|--verbose]
node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
node txt.ts --migrate --from <in.db> --from-creds <from_creds.json> --to-creds <to_creds.json> [-v|--verbose] [--dry-run] [-y|--yes]
```

Entry point is `txt.ts` → `txt/cli.ts`'s `run()` → one of `AdminInitializer` (`adminInit.ts`), `TxtBucketCleaner` (`bucket.ts`), `Migrator` (`migrate.ts`).

## Architecture map

- `instant.schema.ts` / `instant.perms.ts` — InstantDB schema/perms, pushed with `npx instant-cli@latest push [schema|perms] --app <id>`. Changes here need a real push to take effect against the live app; `push schema` reports "No schema changes to apply!" for changes it doesn't diff (confirmed: `onDelete` link config is one such case) — don't trust that message alone when a link's cascade behavior changed.
- `txt/crypto.ts` — `CryptoEngine`: the blob format (`docs/crypto.md`) via the vendored leancrypto WASM module (Ascon-Keccak AEAD + HKDF-SHA3-512), plus HMAC-SHA3-256 username hashing via native Node crypto.
- `txt/sqlcipherBuilder.ts` — raw SQLite C API wrapper (`open`/`insert`/`close`, plus the one-shot `run` for initial schema creation) against whichever VFS the caller registers.
- `txt/r2Vfs.ts` — `R2Vfs`: adapts the vendored in-memory `sqlcipher/js-vfs.mjs` into a page-by-page-over-R2 VFS by prefetching all current pages up front, letting `xRead`/`xWrite` run synchronously against that in-memory buffer, then diffing against the original snapshot to find dirty pages for an explicit async flush.
- `txt/remotePageStore.ts` — `RemotePageStore`: the read (`fetchPage`) and write (`commitPages`) primitives that talk to InstantDB (admin SDK) + R2 for the page store.
- `txt/pagePointer.ts` — `$files` path/content encoding: `path` is plaintext (`pages.pageKey`), the real R2 object address (`raw_path`) is encrypted and uploaded as the file's *content*.
- `txt/owner.ts` — `TxtOwner`: reads the source SQLite schema `--clean-bucket` and the "from" side of `--migrate` operate against — user/key resolution, known R2 paths, part/metadata decoding.
- `txt/instantSignIn.ts` / `txt/firebaseAuth.ts` — Firebase password sign-in → InstantDB `auth.id` exchange (`signInToInstant`, shared by `--init-admin` and `--migrate`).
- `txt/creds.ts` / `txt/initAdminCreds.ts` — creds.json loaders. `Creds` (creds.ts) is the source-account shape (`--clean-bucket`, `--migrate --from-creds`); `InitAdminCreds` (initAdminCreds.ts) is the InstantDB-account shape (`--init-admin`, `--migrate --to-creds`).
- `sqlcipher/` — vendored WASM SQLCipher build + its own JS VFS shim. Not hand-authored here; treat as a build artifact (gitignored from prettier via `.prettierignore`, but tracked in git since there's no build step in this repo to regenerate it).

## Non-obvious constraints (confirmed empirically — don't re-derive, don't assume otherwise)

- **InstaQL always returns a linked sub-entity as an array**, regardless of that link's own declared cardinality (`has: "one"` included). `row.pointerFile[0].url`, not `row.pointerFile.url` — treating it as a plain object produces silently `undefined` fields rather than an error, which can propagate a long way before surfacing (e.g. a 0-byte "reopened" database that looks brand new to SQLite, no error until the first real query against it). See the `instantdb-instaql-array-links` memory.
- **The vendored WASM build is compiled with `WASM_BIGINT`**: 64-bit SQLite C API calls (`sqlite3_bind_int64`, `sqlite3_last_insert_rowid`, `sqlite3_column_int64`) take/return real JS `BigInt`, not `Number`. Confirmed empirically, not documented anywhere in the build.
- **`PRAGMA cipher_default_page_size` must be set before `sqlite3_key()` on every open** (create or reopen), matching `SQLCIPHER_PAGE_SIZE` (`constants.ts`). This codec has no plaintext header for SQLite to sniff the real page size from otherwise — omitting this breaks reopening any non-default-page-size database ("unrecognized magic/version bytes for pgno=1").
- **No Asyncify in this WASM build** — genuine on-demand async fetches from inside a synchronous `xRead`/`xWrite` C callback aren't possible. Hence the prefetch-everything-then-diff model in `r2Vfs.ts`, not lazy per-page fetching.
- **`@instantdb/core`'s `Reactor` is browser-only** — its constructor checks `typeof window !== 'undefined' || typeof chrome !== 'undefined'` and silently skips storage/state setup in Node. `instantSignIn.ts` calls InstantDB's `POST /runtime/oauth/id_token` endpoint directly instead. Don't reach for `@instantdb/core` in this CLI; use `@instantdb/admin` (genuinely Node-safe, bypasses permission rules) or plain `fetch` for anything auth-related.
- **Node's TypeScript strip-only mode doesn't support constructor parameter properties** (`constructor(private x: T)`) — a real syntax transform is needed, not just type erasure. Declare fields and assign in the constructor body instead.
- **R2/InstantDB page round-trips are batched**, not serial or fully unbounded: `RemotePageStore.uploadPages` and `R2Vfs.prefetchPages` both prepare everything up front (pure, no I/O) then issue round-trips `R2_BATCH_CONCURRENCY` (constants.ts) at a time via `Promise.all`.

## Verification

No test framework is configured (`package.json` has no test script). Verification in this project has meant hand-written one-off scripts against real building blocks: a real `CryptoEngine`, a real `SqlCipherBuilder`+`R2Vfs` over a real in-memory VFS, a minimal hand-rolled HTTP mock S3 server (list/put/get/delete, path-style, no SigV4 checking), and a stateful fake InstantDB admin object (`transact`/`query`/`storage.uploadFile` against an in-memory store, following the real `@instantdb/admin` tx builder's `{__etype, __ops}` shape) for anything that doesn't need to hit a real InstantDB app. `global.fetch` gets monkey-patched to redirect specific hostnames to a local mock server when testing Firebase/InstantDB sign-in. These scripts live outside the repo (session scratchpad, not committed) — write new ones the same way rather than assuming a runner exists.

`npm run format` / `npm run format:check` (prettier) exist; run format after any edit.

Some things (the real `@instantdb/admin` `init()` → live query/transact/storage calls) can't be mocked at the HTTP-protocol level without real InstantDB credentials — those need a real run against live infra, with any errors diagnosed from the actual stack trace.

## Commit conventions

Detailed commit messages (imperative subject, bullet-point body explaining what and why), **no AI/Claude attribution ever** (no `🤖 Generated with Claude Code`, no `Co-Authored-By: Claude`), always push after committing. A `/commit` skill (`.claude/commands/commit.md`) automates this.

## Secrets

`.gitignore` blocks all `*.json` except already-tracked ones (`package.json`, `package-lock.json`) — this project repeatedly generates local creds-shaped JSON files with real secrets (Firebase passwords, InstantDB admin tokens, R2 keys). Never commit a JSON file containing real credentials; double-check contents before `git add` on anything JSON-shaped.
