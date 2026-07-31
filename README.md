# txt

A private, end-to-end encrypted reading vault. Documents are chunked into parts, encrypted client-side, and stored as objects in R2/S3; each user's own metadata — titles, read position, bookmarks — lives in that user's own SQLCipher-encrypted SQLite database, which is itself persisted page-by-page (not as one opaque file) in an [rqlite](https://rqlite.io) cluster.

See [docs/data_model.md](docs/data_model.md) for both schemas (the page store and the per-user database) and the reasoning behind every design choice in them, and [docs/crypto.md](docs/crypto.md) for the blob format used wherever content needs its own encryption outside the SQLCipher file.

`txt.ts` is the admin CLI for this design: bringing data in, and day-to-day maintenance of the page store and object storage.

## Install

Requires Node.js 22.6+ (developed and tested against Node 26) — no build step, no bundler; TypeScript sources run directly via Node's native type-stripping.

```
npm install
```

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

## Development

```
npm run typecheck   # tsc --noEmit
npm test            # node --test txt/*.test.ts
npm run format      # prettier --write .
```

Every command has a committed end-to-end test that runs it against a real synthetic database (and, for `--migrate`/`--clean-bucket`, a local mock R2 server) — never against a real database or bucket. `txt/migrate.test.ts` also covers a simulated mid-run failure and the subsequent resume; `txt/vacuum.test.ts` confirms a single `--vacuum` run shrinks both databases and that content survives it.
