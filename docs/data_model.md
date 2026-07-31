# Data Model — rqlite

This project stores each user's data as their own SQLCipher-encrypted SQLite database, not as rows in a shared multi-tenant database. That per-user database's schema is described below under **User SQLCipher Database**. It's persisted as a sequence of encrypted pages in rqlite, described under **rqlite Page Store**. Account/auth data (who a user is, their API key) lives once, at the page-store level — never duplicated inside each tenant's own database.

## rqlite Page Store

Backend: rqlite (a Raft-replicated SQLite). It is a page store: it holds the encrypted pages of a user's SQLCipher database, not rows of application data. Every `pages.data` value is already SQLCipher ciphertext by the time it reaches rqlite — rqlite never sees plaintext or the encryption key, the same client-side-only encryption boundary as the rest of this project.

Storage is append-only and MVCC: a write never overwrites a page row, it inserts a new version. A reader pins a snapshot version at `BEGIN` and only ever sees page versions at or below it, which is what lets reads proceed without blocking writers (and vice versa) using nothing but rqlite's own atomic multi-statement transactions — no separate lock manager, no `SELECT ... FOR UPDATE`. `BEGIN` reads `db_meta.current_version` at rqlite's `strong` (or at least `weak`, leader-routed) consistency level — `pages` and `db_meta` always replicate together in one Raft log entry, so a lagging follower can only ever be *behind*, never internally inconsistent, but reading at `none` from one would still pin a staler snapshot than necessary.

`db_id` is the tenant boundary — one SQLCipher DB per user, and always equal to a `users.user_id` value (enforced by a foreign key, see below). It is set server-side by the OpenResty auth layer on every request from the authenticated identity, never trusted from the client, since rqlite itself has no row-level ACLs to fall back on.

Every timestamp column in this schema (`created_at`, `revoked_at`, `lease_expires_at`, `started_at`) is Unix **milliseconds** — `gc_runs.day_id = floor(unix_time_ms / 86400000)` only buckets one calendar day per row under that assumption. Every foreign key declared below requires `PRAGMA foreign_keys = ON` to actually be enforced: SQLite (rqlite included) accepts a `REFERENCES` clause at `CREATE TABLE` time regardless of ordering or of whether the pragma is set, but silently stops enforcing it the moment the pragma isn't on for a given connection — whatever opens these connections must set it on every one, not just the first.

### Schema

```sql
CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
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

### Tables

- **`users`** — one row per account. `user_id` is a UUIDv4 (stored as `TEXT`), generated once at account creation — not a sequential integer, since this value doubles as `db_id`, the tenant boundary, and a guessable/sortable ID would let one tenant enumerate or infer the existence of others. `role` gates admin-only operations. `disabled` is a kill switch independent of the account's `api_keys` row — it can lock an account out even if its key hasn't been individually revoked.
- **`api_keys`** — exactly one live key per user (`user_id` is the primary key itself). Issuing a new key for a user replaces the old one outright — `DELETE`+`INSERT`, or an `UPDATE` of `key_hash` in place — there is no overlap window where two keys work at once. Simpler than a rotation design, at the cost of a hard cutover: replacing a key immediately invalidates whatever client was using the old one, with no grace period. `key_hash` is the SHA3-256 of the raw key, base64-encoded, never the raw key itself. `revoked_at` is nullable (`NULL` = not revoked); setting it is meant to kill the key immediately, subject to however long the OpenResty auth-cache TTL takes to stop trusting the old value on every replica.
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
- **`active_readers`** — one row per open read transaction, registering the snapshot version it pinned so GC knows the oldest version still in use. A row is expected to be removed on commit/rollback; `lease_expires_at` exists so a crashed client can't block GC forever — the watermark calculation ignores any expired lease when computing the minimum snapshot version still in use. The same daily sweep also runs `DELETE FROM active_readers WHERE lease_expires_at < <sweep start time>` so an expired row doesn't just get ignored forever, it actually gets removed — otherwise every crashed or non-cleanly-closed reader leaves a permanent row behind. Registered/renewed over HTTP via `docker/auth_perms.lua`'s `BEGIN_READ` (an upsert on `(db_id, reader_id)`) and released early on a clean close via `END_READ` — `ui/`'s `data/dbWorker.ts` calls `BEGIN_READ` once at open and again after every commit (to advance `snapshot_version` to what it just committed), plus periodically on a timer so a long read-only session (no commits at all) still renews its lease before it lapses. Without a registered lease, `gcWatermark()` (`txt/rqliteDb.ts`) sees no active readers for that tenant at all and falls back to `current_version`, letting GC delete every page version below the *latest* one out from under a still-open session pinned to an older snapshot.
- **`gc_runs`** — one row per calendar day. `INSERT OR IGNORE` on `day_id` (`floor(unix_time_ms / 86400000)`, milliseconds) is the distributed lock: every OpenResty replica computes the same `day_id`, only the first writer's insert succeeds, everyone else's `rows_affected` comes back 0 and skips running the sweep — no coordinator process needed, just the primary key's own uniqueness.

### Design Notes

- **Read consistency for pinning a snapshot.** `BEGIN` should read `current_version` at `strong` or `weak` rqlite consistency, not `none` — see the schema intro. This bounds staleness; it isn't a correctness requirement, since `pages`/`db_meta` replicate atomically together regardless of consistency level.
- **`db_id` is a `users.user_id` value, not an independent tenant identifier.** All four `db_id` columns (`pages`, `db_meta`, `active_readers`, plus the `users` table itself) are tied together by foreign keys now, so a page row can't outlive, or exist without, its owning account.

## User SQLCipher Database

This is the schema that lives *inside* each user's own SQLCipher database — what's actually sitting in the `pages` rows above, once decrypted. No column here carries its own wrapped encryption key or ciphertext blob: the entire file is already opaque SQLCipher ciphertext before any page of it reaches rqlite, so a second, per-column encryption layer on top of a column would protect against nothing — with one exception, `txt_parts.path`, which points *outside* this database, into R2/S3 object storage the page store above doesn't cover, so the object it points to carries its own encryption instead; see Design Notes below.

### Schema

```sql
CREATE TABLE txt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_key       BLOB    NOT NULL,  -- 128 random bytes
    name          TEXT    NOT NULL,  -- original filename
    metadata      BLOB,              -- brotli(JSON) from a <name>.opf sidecar, if one was found; NULL otherwise
    last_part_num INTEGER,           -- this document's own read position; NULL until first opened
    last_accessed INTEGER,           -- unix ms; NULL until first opened
    created_at    INTEGER NOT NULL,  -- unix ms
    FOREIGN KEY (id, last_part_num) REFERENCES txt_parts(txt_id, part_num)
);

CREATE INDEX idx_txt_last_accessed ON txt(last_accessed DESC);

CREATE TABLE txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    path     TEXT    NOT NULL UNIQUE,  -- object key for this part's encrypted content in R2/S3 storage
    UNIQUE (txt_id, part_num)
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num   INTEGER NOT NULL,
    line       INTEGER NOT NULL,
    preview    TEXT    NOT NULL CHECK (length(preview) <= 60),
    created_at INTEGER NOT NULL,  -- unix ms
    UNIQUE (txt_id, part_num, line)
);

CREATE INDEX idx_txt_bookmarks_txt_id_created_at ON txt_bookmarks(txt_id, created_at);

-- Enforces the per-document bookmark cap in the database instead of relying
-- on every caller to evict before inserting: after each insert, keep only
-- the 20 most recent rows (by created_at, id as tiebreak) for that txt_id
-- and delete the rest.
CREATE TRIGGER trg_txt_bookmarks_cap
AFTER INSERT ON txt_bookmarks
BEGIN
  DELETE FROM txt_bookmarks
  WHERE txt_id = NEW.txt_id
    AND id NOT IN (
      SELECT id FROM txt_bookmarks
      WHERE txt_id = NEW.txt_id
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    );
END;

CREATE TABLE r2_config (
    id                           INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    endpoint                     TEXT NOT NULL,
    region                       TEXT NOT NULL,
    bucket                       TEXT NOT NULL,
    read_only_access_key_id      TEXT NOT NULL,
    read_only_secret_access_key  TEXT NOT NULL,
    read_write_access_key_id     TEXT,  -- NULL for a regular user's db: read-only R2 access only
    read_write_secret_access_key TEXT   -- NULL for a regular user's db: read-only R2 access only
);
```

### Tables

- **`txt`** — one row per document. `name`/`metadata` are this document's ingested filename and optional `<name>.opf` sidecar (`metadata` holds `brotli(JSON)`, `NULL` when no sidecar was found — compression only, not encryption, since this column lives in the SQLCipher file itself); `last_part_num`/`last_accessed` are this document's own read position, `NULL` until first opened. There's no `user_id` column — the database itself is already scoped to one account (its `db_id` in the page store above), so a second identifier here would be redundant. The composite `FOREIGN KEY (id, last_part_num) REFERENCES txt_parts(txt_id, part_num)` keeps a document's read position from ever pointing at a part that doesn't exist for it; it deliberately has no `ON DELETE` action — `ON DELETE SET NULL` on a multi-column foreign key nulls *every* column in that key, which here would include `id` itself (the primary key), so the only safe options are `RESTRICT`/`NO ACTION` (the default). In practice this never blocks anything: the only way a `txt_parts` row disappears today is `ON DELETE CASCADE` from deleting its owning `txt` row outright, at which point the `txt` row (and this constraint along with it) is gone too. `idx_txt_last_accessed` backs the "recently opened" query in Design Notes below.
- **`txt_parts`** — a document's content, chunked into ordered parts (`part_num`, target ~200 KB per part) so a large document isn't loaded/decompressed as a single blob. `path` is the object key for that part's content in R2/S3, not the content itself — the object body is a [crypto.md](crypto.md) blob, `Encrypt(IKM=txt.txt_key, brotli(cleaned part text))`, not plaintext: R2/S3 is a separate store outside the SQLCipher file, so unlike every other column in this schema, it needs its own encryption rather than relying on the page store's. `path` is `UNIQUE` so two parts can never end up pointing at the same object. `UNIQUE (txt_id, part_num)` keeps part numbering consistent and, since a `UNIQUE` constraint creates its own index over exactly those columns, already backs both "does this part number exist" lookups and `SELECT COUNT(*) FROM txt_parts WHERE txt_id=?` for pagination UI — a separate `CREATE INDEX` on the same two columns would just be a second, redundant index paying write cost for no additional query it could serve; a denormalized part-count column would add the same waste plus a way to drift out of sync, for no benefit over the `COUNT(*)`.
- **`txt_bookmarks`** — one row per bookmark, linked to its document via `txt_id`. `part_num` is the part the bookmark falls in; `line` is 1-based, indexing into that part's text as split into lines the same way the reader renders them; `preview` is that line's text truncated to 60 characters, `CHECK`-enforced rather than left as an app-only convention a buggy caller could violate. `UNIQUE (txt_id, part_num, line)` rules out two bookmarks on the exact same line of the same document — re-bookmarking an already-bookmarked line is a constraint violation the caller needs to handle (`INSERT OR IGNORE`/`INSERT OR REPLACE`, or a pre-check), not a silent duplicate row. Deleting a document removes all of its bookmarks via `ON DELETE CASCADE`. The per-document cap (`constants.BOOKMARK_LIMIT`, 20) is enforced by `trg_txt_bookmarks_cap` above, not by the client: every insert leaves at most 20 rows for that `txt_id`, oldest evicted first, regardless of what the calling code does or forgets to do. `idx_txt_bookmarks_txt_id_created_at` backs both that trigger's per-`txt_id` scan and the reader's own "list bookmarks, most recent first" query — since the table only ever holds 20 rows per document, both are cheap short index range scans no matter how many documents or total bookmarks exist.
- **`r2_config`** — exactly one row, holding the R2/S3 credentials `txt_parts.path` objects live under. `id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1)` is the standard SQLite one-row-table pattern: any insert either supplies `id=1` (colliding with the existing row's primary key) or a different value (failing the `CHECK`), so a second row can never exist — an `UPDATE`/`UPSERT` against `id=1` is the only way to change it. Every database gets a full read-only credential pair (`read_only_access_key_id`/`read_only_secret_access_key`) so its owner can always fetch their own document parts; `read_write_access_key_id`/`read_write_secret_access_key` are only populated for the admin account (the one this project's single R2 bucket's write credentials actually belong to) and `NULL` for every regular user's own database. That NOT NULL/NULL split by role isn't something SQL can enforce from inside this schema — `role` lives in the other schema's `users` table, not in here — it's an invariant `txt.ts --update-db` (see [cli.md](cli.md)) upholds by construction: it's the only thing that ever writes this table, and it always writes both read_write columns together (both non-NULL for the admin's own db, both NULL for anyone else's).

### Design Notes

- **Recently-opened lists aren't capped by storage.** `last_part_num`/`last_accessed` live on each document's own row, so there's no shared blob size to protect — a "recently opened" list of any size is just `ORDER BY last_accessed DESC, id DESC LIMIT n` at query time (the `id` tiebreak matters because millisecond timestamps can still collide under fast, scripted writes), backed by `idx_txt_last_accessed`.
- **`txt_parts.path` sits outside the SQLCipher trust boundary.** Every other column here is safe as plaintext because the whole database file is already SQLCipher ciphertext before it leaves the client. That's not true of whatever `path` points to: an R2/S3 object lives in a separate store this schema doesn't cover, so its confidentiality can't come from the page store the way every other column's does — it's encrypted client-side before upload instead, a [crypto.md](crypto.md) blob under `txt.txt_key`. That column resolves what used to be an open question here: the content key isn't derived or stored anywhere separate — it's 128 random bytes generated once per document and stored directly on that document's own `txt` row, protected the same way every other column in this table is (the surrounding SQLCipher encryption), not by anything this table has to manage itself.
- **Where the SQLCipher key itself comes from is a different layer.** This schema describes what's inside the database once it's open; deriving and managing the passphrase that opens it is an auth/key-management concern the rqlite-level schema and OpenResty auth layer own, not a table in here.
