# Data Model — rqlite

Backend: rqlite (a Raft-replicated SQLite). It is a page store: it holds the encrypted pages of a user's SQLCipher database, not rows of application data. Every `pages.data` value is already SQLCipher ciphertext by the time it reaches rqlite — rqlite never sees plaintext or the encryption key, the same client-side-only encryption boundary as the rest of this project.

Storage is append-only and MVCC: a write never overwrites a page row, it inserts a new version. A reader pins a snapshot version at `BEGIN` and only ever sees page versions at or below it, which is what lets reads proceed without blocking writers (and vice versa) using nothing but rqlite's own atomic multi-statement transactions — no separate lock manager, no `SELECT ... FOR UPDATE`. `BEGIN` reads `db_meta.current_version` at rqlite's `strong` (or at least `weak`, leader-routed) consistency level — `pages` and `db_meta` always replicate together in one Raft log entry, so a lagging follower can only ever be *behind*, never internally inconsistent, but reading at `none` from one would still pin a staler snapshot than necessary.

`db_id` is the tenant boundary — one SQLCipher DB per user, and always equal to a `users.user_id` value (enforced by a foreign key, see below). It is set server-side by the OpenResty auth layer on every request from the authenticated identity, never trusted from the client, since rqlite itself has no row-level ACLs to fall back on.

Every timestamp column in this schema (`created_at`, `revoked_at`, `lease_expires_at`, `started_at`) is Unix **seconds**, not milliseconds — `gc_runs.day_id = floor(unix_time / 86400)` only buckets one calendar day per row under that assumption. Every foreign key declared below requires `PRAGMA foreign_keys = ON` to actually be enforced: SQLite (rqlite included) accepts a `REFERENCES` clause at `CREATE TABLE` time regardless of ordering or of whether the pragma is set, but silently stops enforcing it the moment the pragma isn't on for a given connection — whatever opens these connections must set it on every one, not just the first.

## Schema

```sql
CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  rate_tier  TEXT NOT NULL DEFAULT 'free' REFERENCES rate_tiers(tier_id),
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Referenced by users.rate_tier. A row per tier keeps the set of valid
-- tiers extensible (add a row) without a migration, while still rejecting
-- a typo'd tier at write time the way users.role's CHECK does.
CREATE TABLE rate_tiers (
  tier_id TEXT    PRIMARY KEY,
  rate    INTEGER NOT NULL,  -- requests/sec
  burst   INTEGER NOT NULL
);

CREATE TABLE api_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(user_id),
  key_hash   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE pages (
  db_id    TEXT    NOT NULL REFERENCES users(user_id),
  page_no  INTEGER NOT NULL,
  version  INTEGER NOT NULL,
  data     BLOB    NOT NULL,
  PRIMARY KEY (db_id, page_no, version)
);

CREATE INDEX idx_pages_lookup ON pages (db_id, page_no, version DESC);

CREATE TABLE db_meta (
  db_id           TEXT PRIMARY KEY REFERENCES users(user_id),
  current_version INTEGER NOT NULL,
  page_count      INTEGER NOT NULL,
  page_size       INTEGER NOT NULL,
  needs_gc        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE active_readers (
  db_id            TEXT    NOT NULL REFERENCES users(user_id),
  reader_id        TEXT    NOT NULL,
  snapshot_version INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  PRIMARY KEY (db_id, reader_id)
);

CREATE TABLE gc_runs (
  day_id     INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL
);
```

## Tables

- **`users`** — one row per account. `role` gates admin-only operations. `rate_tier` is a foreign key into `rate_tiers`, looked up alongside auth to pick a rate-limit rate/burst pair — an unrecognized tier is rejected at write time instead of silently falling through a lookup elsewhere. `disabled` is a kill switch independent of the account's `api_keys` row — it can lock an account out even if its key hasn't been individually revoked.
- **`rate_tiers`** — the closed set of valid `users.rate_tier` values and the rate/burst pair each one maps to. Adding a tier is an `INSERT`, not a migration; removing one that's still referenced is rejected by the foreign key rather than orphaning accounts on a now-meaningless tier string.
- **`api_keys`** — exactly one live key per user (`user_id` is the primary key itself). Issuing a new key for a user replaces the old one outright — `DELETE`+`INSERT`, or an `UPDATE` of `key_hash` in place — there is no overlap window where two keys work at once. Simpler than a rotation design, at the cost of a hard cutover: replacing a key immediately invalidates whatever client was using the old one, with no grace period. `key_hash` is the SHA3-256 of the raw key, hex-encoded, never the raw key itself. `revoked_at` is nullable (`NULL` = not revoked); setting it is meant to kill the key immediately, subject to however long the OpenResty auth-cache TTL takes to stop trusting the old value on every replica.
- **`pages`** — one row per committed version of one page of one tenant's DB. `data` is opaque SQLCipher ciphertext; rqlite never decrypts it or holds the key. Rows are never updated or deleted by a writer — a commit is always a new `INSERT` with `version = current_version + 1`, which is what makes an in-flight reader's pinned snapshot immune to being mutated out from under it. `idx_pages_lookup` (`db_id, page_no, version DESC`) exists because the primary key's own index is ascending-only; the descending companion lets "latest version at or before my snapshot" (`WHERE db_id=? AND page_no=? AND version<=? ORDER BY version DESC LIMIT 1`) resolve without a reverse scan.
- **`db_meta`** — one row per tenant: the table of contents for a SQLCipher DB. `current_version` is the latest committed version, snapshotted by readers at `BEGIN`. `page_count`/`page_size` back the SQLite VFS's `xFileSize` **for a writer opening at the current version only** — the column isn't versioned, so a reader pinned to an older `snapshot_version` must derive its own file size from its own snapshotted page 1 (SQLite's database header encodes page count there as of whichever version wrote it), never from this column, which only ever reflects the tenant's latest state. `needs_gc` is set to 1 by every committing writer and cleared by the GC sweep, so the daily GC job only touches tenants that actually changed instead of scanning every tenant every run.

  A new tenant's row doesn't exist until created once, before that tenant's first commit: `INSERT OR IGNORE INTO db_meta (db_id, current_version, page_count, page_size, needs_gc) VALUES (?, 0, 0, ?, 0)`. `INSERT OR IGNORE` so two sessions racing to create the same brand-new tenant can't produce two rows — whichever loses just proceeds against the row the winner inserted.
- **The commit pattern** (not a table — how `pages` and `db_meta` are written together). A client-side SQLite commit buffers all dirty pages in memory, then flushes them as one atomic multi-statement rqlite transaction:

  ```sql
  -- guarded INSERT: only actually writes rows if current_version is still old_N
  INSERT INTO pages (db_id, page_no, version, data)
  SELECT db_id, page_no, version, data FROM (
    VALUES (?, ?, N, ?), (?, ?, N, ?), ...            -- (db_id, page_no, version, data) per dirty page
  ) AS dirty(db_id, page_no, version, data)
  WHERE (SELECT current_version FROM db_meta WHERE db_id = ?) = old_N;

  UPDATE db_meta SET current_version=N, page_count=?, needs_gc=1
    WHERE db_id=? AND current_version=old_N;                             -- the CAS
  ```

  The `WHERE current_version=old_N` clause on the `UPDATE` is the concurrency-control mechanism: the client read `old_N` before building this transaction, and if the `UPDATE` reports 0 rows affected, some other writer committed first, so this client must rebuild its dirty pages against the new base version and retry. Both statements execute inside one atomic transaction with no other transaction able to interleave, so they see the same pre-transaction `current_version` — which is why the `INSERT` needs its own copy of the same guard rather than an unconditional `VALUES (...)`: an `UPDATE` matching zero rows is a normal, successful no-op in SQLite, not an error, so without the matching guard on the `INSERT` a writer that loses the CAS race would still have its page rows land, stamped with a version number it never actually won — silently corrupting that version for any reader who later reads a page only the loser touched. Guarding both statements identically means a lost race makes the whole transaction a no-op, together, at the cost of one indexed subquery per statement instead of a flat `VALUES` list.
- **`active_readers`** — one row per open read transaction, registering the snapshot version it pinned so GC knows the oldest version still in use. A row is expected to be removed on commit/rollback; `lease_expires_at` exists so a crashed client can't block GC forever — the watermark calculation ignores any expired lease when computing the minimum snapshot version still in use. The same daily sweep also runs `DELETE FROM active_readers WHERE lease_expires_at < <sweep start time>` so an expired row doesn't just get ignored forever, it actually gets removed — otherwise every crashed or non-cleanly-closed reader leaves a permanent row behind.
- **`gc_runs`** — one row per calendar day. `INSERT OR IGNORE` on `day_id` (`floor(unix_time / 86400)`, seconds) is the distributed lock: every OpenResty replica computes the same `day_id`, only the first writer's insert succeeds, everyone else's `rows_affected` comes back 0 and skips running the sweep — no coordinator process needed, just the primary key's own uniqueness.

## Design Notes

- **Read consistency for pinning a snapshot.** `BEGIN` should read `current_version` at `strong` or `weak` rqlite consistency, not `none` — see the schema intro. This bounds staleness; it isn't a correctness requirement, since `pages`/`db_meta` replicate atomically together regardless of consistency level.
- **`rate_tiers` as a reference table rather than a `CHECK`.** `role` uses an inline `CHECK` because its two values are fixed for the life of the schema; `rate_tier` uses a foreign key into `rate_tiers` instead, because new tiers are expected to be added over time and a `CHECK` would need a migration for each one.
- **`db_id` is a `users.user_id` value, not an independent tenant identifier.** All four `db_id` columns (`pages`, `db_meta`, `active_readers`, plus the `users` table itself) are tied together by foreign keys now, so a page row can't outlive, or exist without, its owning account.
