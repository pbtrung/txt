# CLI Reference

`txt.ts` is the admin CLI: bringing an existing vault onto this project's schema, and day-to-day maintenance of the page store and object storage. See the root [README.md](../README.md) for a short overview and install instructions; this doc covers every flag and creds shape in full.

## `--migrate`

Brings an existing vault database onto this schema: re-encrypts every document part under a fresh per-document key, at a fresh object path, in the same R2/S3 bucket — never touching the old key material or path scheme. Builds the destination user's SQLCipher database for real (via a JS-backed `sqlite3_vfs`, not a simulation), then chops its actual on-disk pages into the `pages`/`db_meta`/`users`/`api_keys` schema, so the output is genuine rqlite seed data. Seeds a fresh admin account whose `api_keys.key_hash` is derived from the `api_key` supplied in `--out-creds` — this tool never generates or prints a key itself.

Commits progress to the output database after every document, not just at the end — the in-progress SQLCipher database only ever lives in memory, so a document isn't durable until its pages are written out. Re-running `--migrate` with the same `--out`/`--out-creds` reopens the existing output, skips every document already committed, and continues from the first one that isn't — no separate resume flag needed. A part failure aborts the run cleanly rather than silently committing a half-migrated document.

```
node txt.ts --migrate \
  --in-creds in_creds.json \
  --in turso_txt.db \
  --out-creds out_creds.json \
  --out rqlite_txt.db \
  [--no-delete] [--verbose]
```

- `--in` — path to the source vault's SQLite file.
- `--in-creds` — JSON file with the credentials needed to read it:
  ```json
  {
    "user_root_key": "<base64>",
    "r2_config": {
      "endpoint": "https://...",
      "read_only_access_key_id": "...",
      "read_only_secret_access_key": "...",
      "read_write_access_key_id": "...",
      "read_write_secret_access_key": "...",
      "region": "auto",
      "bucket": "..."
    }
  }
  ```
  `user_root_key` unwraps the source vault's key chain; `r2_config` needs both pairs, since migrating a part means reading the original and writing/deleting under the new scheme.
- `--out` — path to write the new rqlite-schema database to.
- `--out-creds` — JSON file supplying the new database's raw SQLCipher key and the seeded admin's API key:
  ```json
  {
    "user_root_key": "<base64, at least 256 raw bytes>",
    "api_key": "<base64, at least 32 raw bytes>"
  }
  ```
  `api_key` becomes the admin account's bearer token as-is — it's hashed straight into `api_keys.key_hash` (`base64(SHA3-256(api_key))`, the same way the OpenResty auth layer hashes a bearer token it receives), never generated or printed by this tool. Pick it yourself and keep it, the same way you already keep `user_root_key`.
- `--no-delete` — still writes every new object and database row, just leaves the old R2/S3 objects in place instead of deleting them.
- `--verbose` — prints detailed per-step progress instead of only a final summary.

Only documents whose owner decrypts against the supplied `user_root_key` are migrated — everything ends up under this one new admin account.

## `--clean-bucket`

Deletes every R2/S3 object that isn't referenced by any `txt_parts.path` in the migrated database — orphans left behind by interrupted runs, manual experiments, or anything else. Read-only against `rqlite_txt.db`; only the bucket is ever written to.

```
node txt.ts --clean-bucket --creds creds.json --db rqlite_txt.db [--dry-run] [--verbose]
```

- `--creds` — same shape as `--in-creds` above (`user_root_key` + `r2_config`).
- `--db` — the rqlite-schema database to check references against.
- `--dry-run` — logs what would be deleted without deleting anything; a final summary always prints regardless.
- `--verbose` — logs each referenced-path/bucket-listing step, not just the summary.

## `--collect-garbage`

Sweeps `rqlite_txt.db`'s own page-store tables: page versions superseded before the GC watermark, and expired `active_readers` leases. Skips entirely if `needs_gc` isn't set (nothing has changed since the last sweep). Only ever touches `rqlite_txt.db` — the bucket is untouched (that's what `--clean-bucket` is for).

```
node txt.ts --collect-garbage --db rqlite_txt.db [--dry-run] [--verbose]
```

- `--dry-run` — opens the database read-only and only logs what would be removed.
- `--verbose` — logs each removed page version/reader lease, not just the summary.

## `--vacuum`

Rebuilds the admin's user SQLCipher database first (reclaiming space from deleted rows, defragmenting), commits the result back into `rqlite_txt.db` as a new version, collects the stale page versions that rewrite left behind, then rebuilds `rqlite_txt.db` itself — in that order, since a plain `VACUUM` only reclaims space already-deleted rows freed up, not rows that are merely superseded but still live.

```
node txt.ts --vacuum --creds creds.json --db rqlite_txt.db [--verbose]
```

- `--creds` — same shape as `--out-creds` above; only `user_root_key` is actually used, to open the user database, but `api_key` still has to be present since both commands share the same loader/validation.
- `--verbose` — logs the user database's byte size before/after its own rebuild.

## `--remote-vacuum`

`--vacuum`'s remote counterpart — same three steps (rebuild the user SQLCipher database, collect the pages that rewrite superseded, rebuild the page store's own backing SQLite database), but entirely over the network against a live deployment via `--creds`, with no local file access to `rqlite_txt.db` at all. Opens the user database the same lazy, page-on-demand way `--test-perf`/`--test-write` do (`txt/remoteVfs.ts`'s write support), `VACUUM`s it, and commits the result back; then sweeps garbage and runs a plain `VACUUM` against the page store's own database via the admin-only `RAW_QUERY` escape hatch (`docker/auth_perms.lua`) — per [rqlite's own performance guide](https://rqlite.io/docs/guides/performance/#vacuum), that's a plain SQL statement over the ordinary `/db/execute` API, no dedicated endpoint, but it may temporarily double disk usage and blocks writes while it runs.

```
node txt.ts --remote-vacuum --creds creds.json [--verbose]
```

- `--creds` — same shape as `--test-perf`'s.
- Requires an admin-role `api_key` — both the page-store `VACUUM` and every garbage-collection query go through `RAW_QUERY`, which only `admin` can call. Fails fast with a clear error for a user-role key rather than a confusing 400 partway through.
- `--verbose` — logs each removed page version/reader lease during the garbage-collection step, not just the summary (mirrors `--collect-garbage`'s own flag).

## `--update-db`

Writes/upserts `r2_config`'s single row ([data_model.md](data_model.md)) into the admin's own user SQLCipher database, from `--creds`'s `r2_config` field — the R2/S3 credentials `ui/` reads to fetch (and, for the admin, write) document part content, instead of bundling them into its own unlock creds file. Creates the table if it doesn't exist yet (a database migrated before this command existed won't have it); safe to re-run any time credentials rotate — a second run overwrites the same single row rather than adding another.

```
node txt.ts --update-db --creds creds.json --db rqlite_txt.db [--verbose]
```

- `--creds` — same shape as `--clean-bucket`'s above (`user_root_key` + `r2_config`, both pairs of R2 keys populated — this command always targets the admin account, which per [data_model.md](data_model.md) needs full read-write access, not just read-only).
- `--db` — the rqlite-schema database to write into.
- `--verbose` — logs the `db_id` the row was written to.

## `--test-perf`

Opens a real, remote user database over real HTTP to a live OpenResty+rqlite deployment (`docker/`), reading it lazily -- one page fetched on demand as SQLite actually asks for it, cached for the rest of the run -- instead of the "read every page, build the full db in memory" model every other command here uses (`RqliteDb.latestPages`/`UserDb.resume`). Runs 5 fixed `SELECT`s against it and reports network round trips, per-round-trip and total timing, and bytes fetched, so that tradeoff is measured rather than assumed.

```
node txt.ts --test-perf --creds creds.json [--verbose]
```

- `--creds` — JSON file pointing at the live deployment:
  ```json
  {
    "rqlite_url": "https://host:4001",
    "api_key": "<base64, this account's own bearer token>",
    "user_root_key": "<base64, at least 256 raw bytes>"
  }
  ```
  `api_key` can be any role's key. `GET_META`/`READ_PAGE` are ordinary user-level statements in `docker/auth_perms.lua`, forced to the caller's own account server-side for a `user`-role key -- but `auth_perms.lua` gives **admin** no implicit self, so acting on any tenant (including the admin's own account) always needs an explicit `target_db_id`. Rather than requiring you to already know and supply your own `user_id`, `--test-perf` looks it up itself the same way `auth_perms.lua`'s own identity resolution does -- `api_keys.key_hash` (computed client-side, identically to how the OpenResty auth layer hashes a bearer token) `-> users.user_id`, via `RAW_QUERY` -- so an admin key transparently tests its own account with no extra field in `--creds` needed.
- `--verbose` — logs the fetched `db_meta` (version/page count/page size) before running any queries.

The synchronous-looking `xRead` a WASM VFS callback requires is bridged to a real async HTTP fetch via a worker thread + `SharedArrayBuffer`/`Atomics.wait` (`txt/remotePageWorker.ts`, `txt/remoteVfs.ts`) -- the main thread blocks on `Atomics.wait` while the worker does the actual network round trip and wakes it back up, rather than requiring a rebuild of the vendored `sqlcipher.js`/`.wasm` bundle with Asyncify support.

Unlike `ui/`'s own lazy-VFS session (`data/dbWorker.ts`), `--test-perf` never registers an `active_readers` lease (`BEGIN_READ`/`END_READ`, `docker/auth_perms.lua`) for its own pinned snapshot -- a real gap, not a deliberate one, just not yet ported here. Since it's a short, one-shot run rather than a long-lived session, the exposure window is small, but a `--collect-garbage` sweep landing mid-run could in principle still delete a page version this command still needs.

## `--test-write`

Opens a real, remote user database read-write against a live deployment (the same lazy VFS `--test-perf` uses read-only, extended here with real write support ported from `ui/`'s browser client -- `txt/remoteVfs.ts`'s `dirtyPage`/`xWriteBacked`/`commit`), records a read position and adds a bookmark for one existing `txt` row, commits, then closes everything and opens an entirely independent second session against the server to check whether that write is actually visible there. Built to reproduce and diagnose "a write that appears to succeed doesn't show up in a later session" -- a real bug this uncovered once already (a stale server-side page read, still being root-caused as of this writing).

```
node txt.ts --test-write --creds creds.json [--log-file test-write.log] [--verbose]
```

- `--creds` — same shape as `--test-perf`'s (above).
- `--log-file` — where the full diagnostic trace goes, always, regardless of `--verbose`: every page read/write/commit, each tagged with a cheap content fingerprint (`remoteVfs.ts`'s `fingerprint()`) so a page's content at write time can be compared byte-for-byte against what the independent second session's read of that same page number returns. Defaults to `test-write.log` in the current directory. `--verbose` only controls how much of that same detail also prints to stdout -- the log file always gets everything.
- Ends by printing a `RESULT: PASS`/`FAIL` summary comparing what was written against what the second session read back.

Shares `--test-perf`'s two known gaps: no `active_readers` lease registered for either session's pinned snapshot, and the worker+`Atomics`+real-HTTP round trip isn't covered by a committed test (see `--test-perf`'s own notes above) -- though `txt/remoteVfs.test.ts` does cover the write+commit+independent-second-VFS round trip itself, against a real local HTTP server standing in for the page store.

## Development

```
npm run typecheck   # tsc --noEmit
npm test            # node --test txt/*.test.ts
npm run format      # prettier --write .
```

Every command has a committed end-to-end test that runs it against a real synthetic database (and, for `--migrate`/`--clean-bucket`, a local mock R2 server) — never against a real database or bucket. `txt/migrate.test.ts` also covers a simulated mid-run failure and the subsequent resume; `txt/vacuum.test.ts` confirms a single `--vacuum` run shrinks both databases and that content survives it.

`--test-perf` is the one exception to "every command has an end-to-end test": `txt/rqliteHttpClient.test.ts` covers the real HTTP request/response layer (a real local mock server, no worker thread involved) and `txt/remoteVfs.test.ts` covers the lazy VFS's paging/caching/decryption logic directly (a fake synchronous `fetchPage`, no network involved), but the actual worker+`Atomics`+real-HTTP round trip that connects the two in `--test-perf` itself isn't covered by a committed test -- real outbound network I/O from a worker thread while the main thread blocks in `Atomics.wait` was found to stall indefinitely in at least one sandboxed development environment (everything else about the mechanism, including the same blocking bridge with non-network worker responses, checks out). Verify that specific combination manually against a real deployment before relying on it in an environment you haven't already tried it in. `--test-write` and `--remote-vacuum` share this same gap for the same reason (both open a session the identical way) -- `--remote-vacuum`'s own garbage-collection step is the exception to the exception: `txt/remoteGc.test.ts` covers it end-to-end against a real local mock server whose handler executes each `RAW_QUERY`'s literal SQL against a real `SqliteDb`, the same scenario `collectGarbage.test.ts` uses for the local command.
