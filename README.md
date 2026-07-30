# txt

A migration tool that moves a `txt` vault off its old shared, column-encrypted Turso/libSQL schema and onto the new design: one SQLCipher-encrypted database per user, itself stored page-by-page in an [rqlite](https://rqlite.io) page store. See [docs/data_model.md](docs/data_model.md) for both schemas and [docs/crypto.md](docs/crypto.md) for the blob format used throughout.

## Main features

- **`--migrate`** — reads an old vault (`turso_txt.db`) and re-encrypts every document part under a fresh per-document key, at a fresh object path, in the same R2/S3 bucket — never touching the old key material or path scheme.
- Builds the migrated user's SQLCipher database for real (via a JS-backed `sqlite3_vfs`, not a simulation), then chops its actual on-disk pages into the target `pages`/`db_meta`/`users`/`rate_tiers`/`api_keys` schema, so the output is genuine rqlite seed data, not just a reshaped copy of the input.
- Seeds a fresh admin account and API key for the migrated vault (the raw key is printed once and never stored).
- **Commits progress to `rqlite_txt.db` after every document**, not just at the end — the in-progress SQLCipher database only ever lives in memory, so a document isn't durable until its pages are written out. If the process is interrupted, whatever was fully migrated is safely on disk.
- **Resumable across runs**: re-running `--migrate` with the same `--out`/`--out-creds` reopens the existing output, skips every document already committed, and continues from the first one that isn't — no separate resume flag needed.
- A part failure aborts the run cleanly rather than silently committing a half-migrated document — whatever completed before it stays committed, and a re-run picks up exactly where it left off once the underlying issue (e.g. a network blip) is fixed.
- `--no-delete` to keep old R2/S3 objects around instead of deleting them once their replacement is confirmed written and committed.
- `--verbose` for detailed per-step progress (metadata resolution, each part's download/upload/insert, each commit, each deletion).

## Install

Requires Node.js 22.6+ (developed and tested against Node 26) — no build step, no bundler; TypeScript sources run directly via Node's native type-stripping.

```
npm install
```

## Usage

```
node txt.ts --migrate \
  --in-creds in_creds.json \
  --in turso_txt.db \
  --out-creds out_creds.json \
  --out rqlite_txt.db \
  [--no-delete] [--verbose]
```

- `--in` — path to the old vault's SQLite file.
- `--in-creds` — JSON file with the credentials needed to read it:
  ```json
  {
    "user_root_key": "<base64>",
    "r2_config": {
      "endpoint": "https://...",
      "read_write_access_key_id": "...",
      "read_write_secret_access_key": "...",
      "region": "auto",
      "bucket": "..."
    }
  }
  ```
  `user_root_key` unwraps the old vault's `umk`/`txt_key` chain; `r2_config` needs read, write, _and_ delete access, since migrating a part means writing its replacement and removing the original from the same bucket.
- `--out` — path to write the new rqlite-schema database to.
- `--out-creds` — JSON file supplying the new database's raw SQLCipher key:
  ```json
  { "user_root_key": "<base64, at least 256 raw bytes>" }
  ```
- `--no-delete` — still writes every new object and database row, just leaves the old R2/S3 objects in place instead of deleting them.
- `--verbose` — prints detailed per-step progress instead of only a final summary.

Only documents whose owner's `umk_store` row decrypts against the supplied `user_root_key` are migrated. `users`, `txt_access`, `bookmarks`, `txt_shares`, and `key_store` are never read at all — the new schema has no equivalent, so nothing from them is carried forward.

## Development

```
npm run typecheck   # tsc --noEmit
npm test            # node --test txt/*.test.ts
npm run format       # prettier --write .
```

`txt/migrate.test.ts` runs the whole migration end to end against a small synthetic vault and a local mock R2 server, including a simulated failure and a subsequent resume — it never touches a real database or bucket.
