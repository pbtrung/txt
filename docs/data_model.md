# Data Model — rqlite

Backend: rqlite (a Raft-replicated SQLite). It is a page store: it holds the encrypted pages of a user's SQLCipher database, not rows of application data. Every `pages.data` value is already SQLCipher ciphertext by the time it reaches rqlite — rqlite never sees plaintext or the encryption key, the same client-side-only encryption boundary as the rest of this project.

Storage is append-only and MVCC: a write never overwrites a page row, it inserts a new version. A reader pins a snapshot version at `BEGIN` and only ever sees page versions at or below it, which is what lets reads proceed without blocking writers (and vice versa) using nothing but rqlite's own atomic multi-statement transactions — no separate lock manager, no `SELECT ... FOR UPDATE`.

`db_id` is the tenant boundary — one SQLCipher DB per user. It is set server-side by the OpenResty auth layer on every request from the authenticated identity, never trusted from the client, since rqlite itself has no row-level ACLs to fall back on.

## Schema

```sql
CREATE TABLE pages (
  db_id    TEXT    NOT NULL,
  page_no  INTEGER NOT NULL,
  version  INTEGER NOT NULL,
  data     BLOB    NOT NULL,
  PRIMARY KEY (db_id, page_no, version)
);

CREATE INDEX idx_pages_lookup ON pages (db_id, page_no, version DESC);

CREATE TABLE db_meta (
  db_id           TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL,
  page_count      INTEGER NOT NULL,
  page_size       INTEGER NOT NULL,
  needs_gc        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE active_readers (
  db_id            TEXT    NOT NULL,
  reader_id        TEXT    NOT NULL,
  snapshot_version INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  PRIMARY KEY (db_id, reader_id)
);

CREATE TABLE gc_runs (
  day_id     INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL
);

CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  rate_tier  TEXT NOT NULL DEFAULT 'free',
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(user_id),
  key_hash   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
```

## Tables

- **`pages`** — one row per committed version of one page of one tenant's DB. `data` is opaque SQLCipher ciphertext; rqlite never decrypts it or holds the key. Rows are never updated or deleted by a writer — a commit is always a new `INSERT` with `version = current_version + 1`, which is what makes an in-flight reader's pinned snapshot immune to being mutated out from under it. `idx_pages_lookup` (`db_id, page_no, version DESC`) exists because the primary key's own index is ascending-only; the descending companion lets "latest version at or before my snapshot" (`WHERE db_id=? AND page_no=? AND version<=? ORDER BY version DESC LIMIT 1`) resolve without a reverse scan.
- **`db_meta`** — one row per tenant: the table of contents for a SQLCipher DB. `current_version` is the latest committed version, snapshotted by readers at `BEGIN`. `page_count`/`page_size` back the SQLite VFS's `xFileSize`. `needs_gc` is set to 1 by every committing writer and cleared by the GC sweep, so the daily GC job only touches tenants that actually changed instead of scanning every tenant every run.
- **The commit pattern** (not a table — how `pages` and `db_meta` are written together). A client-side SQLite commit buffers all dirty pages in memory, then flushes them as one atomic multi-statement rqlite transaction:

  ```sql
  INSERT INTO pages (db_id, page_no, version, data) VALUES (...), (...), ...  -- all dirty pages, version = N
  UPDATE db_meta SET current_version=N, page_count=?, needs_gc=1
    WHERE db_id=? AND current_version=old_N                                   -- the CAS
  ```

  The `WHERE current_version=old_N` clause is the entire concurrency-control mechanism: the client read `old_N` before building this transaction, and if the `UPDATE` reports 0 rows affected, some other writer committed first, so this client must rebuild its dirty pages against the new base version and retry. rqlite's own transaction atomicity guarantees both statements land together or not at all. (See the audit below — "together or not at all" is true of each statement's own success/failure, but a 0-row `UPDATE` is not a failure, which matters here.)
- **`active_readers`** — one row per open read transaction, registering the snapshot version it pinned so GC knows the oldest version still in use. A row is expected to be removed on commit/rollback; `lease_expires_at` exists so a crashed client can't block GC forever — the watermark calculation simply ignores any lease that's expired.
- **`gc_runs`** — one row per calendar day. `INSERT OR IGNORE` on `day_id` (`floor(unix_time / 86400)`) is the distributed lock: every OpenResty replica computes the same `day_id`, only the first writer's insert succeeds, everyone else's `rows_affected` comes back 0 and skips running the sweep — no coordinator process needed, just the primary key's own uniqueness.
- **`users`** — one row per account. `role` gates admin-only operations. `rate_tier` is looked up alongside auth to pick a rate-limit rate/burst pair. `disabled` is a kill switch independent of the account's `api_keys` row — it can lock an account out even if its key hasn't been individually revoked.
- **`api_keys`** — exactly one live key per user (`user_id` is the primary key itself). Issuing a new key for a user replaces the old one outright — `DELETE`+`INSERT`, or an `UPDATE` of `key_hash` in place — there is no overlap window where two keys work at once. Simpler than a rotation design, at the cost of a hard cutover: replacing a key immediately invalidates whatever client was using the old one, with no grace period. `key_hash` is the SHA3-256 of the raw key, hex-encoded, never the raw key itself. `revoked_at` is nullable (`NULL` = not revoked); setting it is meant to kill the key immediately, subject to however long the OpenResty auth-cache TTL takes to stop trusting the old value on every replica.

## Correctness & Consistency Audit

### Critical — a lost CAS race can still leave its pages visible

The commit pattern sends the page `INSERT`s and the `db_meta` CAS `UPDATE` as one transaction, but "one transaction" only guarantees they commit or roll back *together on error* — an `UPDATE` that matches zero rows is not an error in SQLite/rqlite, it's a normal, successful no-op. So when two writers race for the same `db_id`:

1. Both read `current_version = 5` and both build a commit for `version = 6`.
2. Writer A dirties pages `{10, 11}`; writer B dirties a disjoint set, `{20, 21}`. Neither `INSERT` collides with the other on the `(db_id, page_no, version)` primary key, so both `INSERT`s succeed regardless of which transaction lands first.
3. Whichever transaction's Raft log entry applies first also wins the CAS (`current_version: 5 -> 6`). The second transaction's `UPDATE` matches 0 rows and does nothing — but its `INSERT` already committed. Its page rows for `20` and `21` are now sitting in the table stamped `version = 6`, and `current_version` is (coincidentally) already `6`.
4. A reader that pins `snapshot_version = 6` right now and asks for page `20` gets the *losing* writer's data back, indistinguishable from a legitimate part of version 6 — even though, logically, only writer A's commit became version 6, and it never touched page 20.

This is silent data corruption, not just wasted space: the loser's own retry logic (rebuild against the new base, try again as version 7) is fine, but it doesn't undo the garbage `INSERT` already sitting at version 6, and nothing else in this schema ever revisits it — it isn't "below the GC watermark," so the GC sweep has no reason to touch it either.

A fix that stays within a single round trip: make the page `INSERT` itself conditional on the same guard as the `UPDATE`, e.g. `INSERT INTO pages (...) SELECT ... WHERE (SELECT current_version FROM db_meta WHERE db_id=?) = old_N` (or an equivalent `WHERE EXISTS (...)` guard) instead of an unconditional `VALUES (...)`. Both statements then read the same pre-transaction `current_version` and both become no-ops together when the CAS would have failed, at the cost of one indexed subquery per statement instead of a flat `VALUES` list.

### page_count is only ever the tenant's latest value, not the reader's snapshotted value

`db_meta.page_count` isn't versioned — it's overwritten in place on every commit. A reader pinned to an older `snapshot_version` has no way to ask "what was `page_count` *at that version*," only "what is it right now." If the file has since grown or shrunk (a later commit, or a `VACUUM`), wiring a snapshot read's `xFileSize` straight to `db_meta.page_count` would report the wrong size for that reader's own pinned view. SQLite's own database header (page 1, bytes 28–31) already encodes the file's size in pages as of whichever version wrote it, so a correct implementation must derive a snapshot reader's file size from *its own* pinned page 1, not from this column — worth stating explicitly wherever `xFileSize` gets implemented, since `db_meta.page_count` is the right source only for a writer opening at the current version.

### Foreign keys aren't enforced unless every connection turns them on

`api_keys.user_id REFERENCES users(user_id)` is the only declared foreign key in this schema, and SQLite (rqlite included) doesn't enforce foreign keys unless `PRAGMA foreign_keys = ON` is set per connection — it's off by default. Whatever issues the `PRAGMA` (or wherever rqlite's own config exposes it) needs to actually do so, on every node, or this constraint is documentation only.

Separately, `pages.db_id`, `db_meta.db_id`, and `active_readers.db_id` have no foreign key to `users.user_id` at all, even though the design summary says `db_id` *is* the tenant/user boundary. If `db_id` is meant to always equal a `users.user_id` value, that should be stated as a hard invariant (and ideally FK-enforced with the pragma above); if it's meant to be a separate, possibly-not-1:1 tenant identifier, the schema should say so instead of leaving the relationship implicit.

### Bootstrapping a new tenant's `db_meta` row is unspecified

The commit pattern's CAS assumes a `db_meta` row already exists (`UPDATE ... WHERE db_id=? AND current_version=old_N`). Nothing here creates the first row for a brand-new `db_id` — that has to be an `INSERT OR IGNORE` (or equivalent) run once, before the first commit, with some agreed starting `current_version`/`page_count`/`page_size`. Worth pinning down explicitly (including what `page_size` a new tenant gets, since the column is described as "fixed per DB at creation" but nothing enforces that after the row is inserted — a later `UPDATE` could still change it).

### `active_readers` rows are only ever ignored, never swept

The design leans on GC ignoring an expired `lease_expires_at` when computing the watermark, which correctly stops a crashed client from blocking GC forever — but nothing here deletes the row itself once its lease expires. Over time `active_readers` accumulates one permanent row per reader that ever crashed or failed to clean up on rollback. The GC sweep (or a separate periodic job) should also `DELETE FROM active_readers WHERE lease_expires_at < now()`, not just skip past them when computing the minimum snapshot version.

### Timestamp units are never pinned down

`gc_runs.day_id = floor(unix_time / 86400)` only produces one bucket per calendar day if `unix_time` is in seconds. `users.created_at`, `api_keys.created_at`/`revoked_at`, and `active_readers.lease_expires_at` are all just commented "unix time" with no unit stated. If any producer of these values uses milliseconds (a common JS-side default) instead of seconds, `day_id` silently buckets 1000 days into one and every lease/expiry comparison against it is off by 1000x. Worth a single explicit statement — e.g. "every timestamp column in this schema is Unix seconds" — so it isn't left to be inferred from `gc_runs` alone.

### `rate_tier` isn't validated the way `role` is

`role` is constrained to `('user', 'admin')` by a `CHECK`; `rate_tier` is free-form `TEXT` with only a default. If the set of valid tiers is meant to be closed (looked up against a fixed rate/burst table elsewhere), an unconstrained column lets a typo'd tier silently fall through to whatever the lookup does with an unrecognized key, rather than failing at write time the way an invalid `role` would. If tiers are meant to be extensible without a migration, this is fine as-is — just worth confirming it's the intended asymmetry rather than an oversight.

### Read consistency level for pinning a snapshot isn't specified

rqlite exposes multiple read consistency levels (`none`, `weak`, `strong`). Because `pages` and `db_meta` are always written together in one Raft-committed transaction, a follower can only ever be *behind* the leader, never internally inconsistent — so this isn't a correctness bug the way the CAS race above is. But a reader that pins its snapshot via a `none`-consistency read of `current_version` from a lagging follower will see a staler snapshot than one reading at `weak` (routed to the leader). Worth stating which level `BEGIN` is expected to use, since it changes staleness bounds even though it doesn't change correctness.
