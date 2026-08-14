# Remote Page Store — Design

A SQLite database whose pages live as immutable objects in R2/S3, mapped by a per-user Turso Cloud database, with a small derived catalogue the client downloads for its library UI.

---

## 1. Components

| name | what it is | where |
|---|---|---|
| **AA** | container database: the page map, version history, snapshot pins, bundle and library-index pointers | Turso Cloud, one database per user, HTTP API only |
| **BB** | inside database: the application's SQLCipher-keyed SQLite database | pages are objects in R2/S3; no local file |
| **library index** | a small SQLite file holding BB's bibliographic data, rebuilt from BB and downloaded whole by the client | one object in R2/S3, pointed at by a row in AA |

One user owns one AA, one BB, one `db_prefix`, and one library index. Nothing in AA or BB carries a user identifier. AA holds no encryption keys.

The application opens a normal SQLCipher connection to BB and issues normal SQL. Underneath, page reads are HTTP GETs against R2/S3 and the commit point is one HTTP request to AA.

Invariants:

- **One AA describes one BB.** Enforced by a singleton row in AA (§3.1).
- **Objects are never overwritten** — except the library index, which is a derived artefact (§7).
- **AA is remote.** Every AA access is a network round trip. Every multi-statement operation is a single batch; interactive transactions are never used.
- **Page content never touches local disk.** Page bytes live in memory only.

---

## 2. Object storage

```
s3://{bucket}/{db_prefix}/p/{key[0:2]}/{key}     -- BB page versions      (AA-owned)
s3://{bucket}/{db_prefix}/t/{key[0:2]}/{key}     -- document part payloads (BB-owned)
s3://{bucket}/{db_prefix}/i/{key[0:2]}/{key}     -- the library index     (AA-owned)
```

`db_prefix` and every `key` are 32 random bytes rendered as 52 lowercase base32-Crockford characters. `db_prefix` is minted once at creation; page keys are minted once per upload and never reused. `{key[0:2]}` is a shard directory for navigability during cleanup only — lookup never goes through it.

The three populations have different lifecycle owners, so they are separated by prefix: the page garbage collector lists `p/` only, the application's document-delete path lists `t/` only.

Object bodies are the exact bytes handed to the writer: SQLCipher ciphertext for pages, application-encrypted payloads for parts and the library index. No wrapping header, no S3 tags, no user metadata.

---

## 3. AA schema

Every statement is issued over the HTTP API in batches.

### 3.1 Singleton

```sql
CREATE TABLE meta (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version    INTEGER NOT NULL,
  db_prefix         TEXT    NOT NULL,
  page_size         INTEGER NOT NULL,      -- fixed for the life of BB
  head_version      INTEGER NOT NULL DEFAULT 0,
  gc_horizon        INTEGER NOT NULL DEFAULT 0,
  index_dirty_at    INTEGER,               -- BB version needing a library-index rebuild, §7.3
  created_at        INTEGER NOT NULL
);
```

`CHECK (id = 1)` is what makes "one AA, one BB" structural: a second database cannot be inserted. Every other table is scoped by that fact and carries no scoping column.

`page_size` is read from AA at open, before SQLite has read page 1.

### 3.2 Page map

```sql
CREATE TABLE versions (
  version        INTEGER PRIMARY KEY,      -- also the write fence, §6.2
  parent_version INTEGER,
  committed_at   INTEGER NOT NULL,
  page_count     INTEGER NOT NULL          -- logical size of BB at this version
);

CREATE TABLE page_versions (
  page_no         INTEGER NOT NULL,
  version_created INTEGER NOT NULL,
  version_deleted INTEGER,                 -- NULL = current
  object_key      TEXT    NOT NULL,
  checksum        BLOB    NOT NULL,        -- 16 bytes, BLAKE3-128 of the object body
  PRIMARY KEY (page_no, version_created)
) WITHOUT ROWID;

CREATE INDEX idx_pv_live
  ON page_versions(page_no, object_key, checksum) WHERE version_deleted IS NULL;
CREATE INDEX idx_pv_created ON page_versions(version_created);
CREATE INDEX idx_pv_deleted ON page_versions(version_deleted);
```

A row is visible at version `V` when `version_created <= V AND (version_deleted IS NULL OR version_deleted > V)`. The clustered primary key groups a page's versions in ascending order, so the as-of lookup for a single page needs no secondary structure:

```sql
SELECT object_key, checksum
  FROM page_versions
 WHERE page_no = :pgno
   AND version_created <= :v
   AND (version_deleted IS NULL OR version_deleted > :v)
 ORDER BY version_created DESC
 LIMIT 1;
```

`idx_pv_live` is covering, so the bulk map load at open is an index-only scan.

### 3.3 Snapshots

```sql
CREATE TABLE snapshots (
  snapshot_id  TEXT PRIMARY KEY,           -- client-generated UUID
  version      INTEGER NOT NULL,
  holder       TEXT    NOT NULL,           -- host:pid:uuid, diagnostics only
  opened_at    INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_version   ON snapshots(version);
CREATE INDEX idx_snapshots_heartbeat ON snapshots(heartbeat_at);
```

A live, heartbeated snapshot row prevents garbage collection of anything visible at its version.

### 3.4 Bundles

```sql
CREATE TABLE bundles (
  bundle_key       TEXT PRIMARY KEY,       -- object key under p/
  built_at_version INTEGER NOT NULL,
  byte_size        INTEGER NOT NULL,
  map_rows         INTEGER NOT NULL,
  page_count       INTEGER NOT NULL,       -- hot pages carried
  built_at         INTEGER NOT NULL,
  retired_at       INTEGER
);
```

### 3.5 Library index pointer

```sql
CREATE TABLE library_index (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  object_key       TEXT    NOT NULL,       -- fixed key under i/, minted once
  built_at_version INTEGER NOT NULL,       -- BB version this file projects
  byte_size        INTEGER NOT NULL,       -- compressed and encrypted size
  doc_count        INTEGER NOT NULL,
  content_hash     BLOB    NOT NULL,       -- 16 bytes; the client's cache validator
  built_at         INTEGER NOT NULL
);
```

One row, one object key, updated in place on each rebuild.

---

## 4. Local state

Per open BB, held in memory only:

| structure | contents | bound |
|---|---|---|
| `page_map` | `page_no → (object_key, checksum)` at the pinned version | ~48 bytes per live page |
| `page_cache` | `object_key → bytes` | configured byte budget, LRU eviction |
| `staged` | `page_no → bytes` for the open write transaction | transaction size |
| `pinned_version`, `snapshot_id`, `page_count` | scalars | — |

Object keys name one immutable version of one page, so a cached page never needs invalidation — only eviction. The same holds for map entries: a `(page_no → object_key)` pair for a pinned version is a permanent fact about that version.

A multi-database process runs one memory governor across all open BBs, evicting from the largest cache when the process budget is exceeded.

---

## 5. VFS

| call | behaviour |
|---|---|
| `xOpen` | main database only; journal and temp files are in-memory |
| `xRead` | serve from `staged`, then `page_cache`, then GET the object named by `page_map`; verify checksum |
| `xWrite` | write into `staged`; never touches the network |
| `xFileSize` | `page_count * page_size` from the pinned version |
| `xSync` | no-op |
| `xTruncate` | records a smaller `page_count` for the next commit |
| `xLock` / `xUnlock` | in-process advisory only; cross-process safety is the fence (§6.2) |
| `xDeviceCharacteristics` | `SQLITE_IOCAP_ATOMIC`, `SQLITE_IOCAP_SAFE_APPEND`, `SQLITE_IOCAP_SEQUENTIAL` |

`PRAGMA journal_mode = MEMORY`, `PRAGMA synchronous = OFF`, `PRAGMA auto_vacuum = NONE`, `PRAGMA temp_store = MEMORY`, `PRAGMA cache_size` sized to hold the working set. WAL is not supported: it requires shared-memory coordination and a second file.

Sorts, index builds, and temporary tables spill to RAM, so `PRAGMA cache_size` and the process memory budget must accommodate the largest expected sort.

---

## 6. Read and write paths

### 6.1 Open

One AA batch:

1. read `meta`;
2. read `head_version` and its `page_count` from `versions`;
3. insert a `snapshots` row pinning that version;
4. read the live `bundles` row.

Then warm the map:

- **Bundle present.** GET the bundle, load its map section into `page_map`, insert its hot pages into `page_cache` keyed by object key, then apply the delta from AA: all `page_versions` rows with `version_created > built_at_version` and visible at the pinned version, plus rows whose `version_deleted` falls in that range.
- **No bundle.** Paginated scan of `idx_pv_live` at the pinned version.

After warmup the map is complete: steady-state reads make no AA calls at all, only GETs for uncached pages.

### 6.2 Commit

`COMMIT` runs a checkpoint. `staged` holds every dirtied page, including page 1.

1. Mint a fresh random key per dirtied page.
2. PUT all page objects concurrently. Retrying a PUT is unconditionally safe: the key is new and nothing references it yet.
3. Send one AA batch:
   - `INSERT INTO versions (version, parent_version, committed_at, page_count)` with `version = pinned + 1`;
   - `INSERT INTO page_versions` one row per uploaded page, `version_created = version`;
   - `UPDATE page_versions SET version_deleted = version` for the superseded rows of those page numbers;
   - `UPDATE meta SET head_version = version`.
4. On success: advance `pinned_version`, apply the new keys to `page_map`, move `staged` bytes into `page_cache`, clear `staged`.

The batch is one server-side transaction, so the commit is atomic. `versions.version` is the primary key, which makes it the write fence: two writers that both allocated `N+1` cannot both succeed. The loser gets a primary-key violation, discards its local state, and reopens its connection at the new head. Its uploaded objects are unreferenced and are reclaimed by the orphan sweep.

If the response is lost, the writer re-reads `versions` for its intended version and `committed_at`: present means the commit landed.

A checkpoint larger than the configured limit (default 20,000 pages) is split into batches of page uploads followed by one final AA batch; the AA batch is still single and still atomic.

### 6.3 Bundles

A bundle is one object under `p/`:

```
[ header ]     magic, format version, page_size, built_at_version,
               section offsets and lengths, per-section checksums
[ page map ]   (page_no, object_key, checksum) for every live page at built_at_version
[ hot pages ]  raw bytes of page 1, of every btree interior page, and of every
               btree small enough to carry whole
[ index ]      (object_key, offset, length) per hot page
```

The hot-page index is keyed by object key, not page number, so a bundle of any age is correct: it seeds the cache with immutable `key → bytes` facts, and `page_map` remains the sole arbiter of which keys a reader wants. Nothing about a bundle is ever validated, only superseded.

Membership of the hot-pages section is decided at build time by a `dbstat` scan on a connection holding the key. Rebuild when the count of distinct page numbers changed since `built_at_version` exceeds 25% of the live page count. Set `retired_at` on the previous bundle and let GC delete it after a grace window longer than a slow download.

### 6.4 Garbage collection

Runs periodically on the writer.

1. `gc_horizon = MIN(version)` over live `snapshots`, or `head_version` if there are none.
2. Delete objects for `page_versions` rows with `version_deleted <= gc_horizon`, then delete the rows.
3. Delete retired bundles past their grace window.
4. Orphan sweep: list `p/`, delete objects that appear in neither `page_versions` nor `bundles` and are older than the longest possible in-flight checkpoint.

A snapshot whose `heartbeat_at` is older than three heartbeat intervals is deleted; readers heartbeat every 30 seconds and re-pin on failure.

Pinning and the horizon check are two halves of one invariant: a reader pins in the same batch that reads `head_version`, so a reader either pins a version at or above the horizon or fails and retries.

---

## 7. BB schema

BB stores document structure and user state. Document text lives in the `t/` object population, one object per part, referenced by `txt_parts.path`.

Tables are grouped by write frequency, because the page is the unit of versioning: any byte changed rewrites the whole 4 KiB page as a new object and a new AA row. `txt` is written once, `txt_meta` changes when the user edits metadata, `txt_access` changes continuously.

```sql
-- Documents. Written at import, then immutable.
CREATE TABLE txt (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- ids are never recycled
    txt_key    BLOB    NOT NULL,                   -- 128 random bytes
    name       TEXT    NOT NULL,                   -- original filename
    n_parts    INTEGER NOT NULL,
    created_at INTEGER NOT NULL                    -- unix ms
);

-- OPF sidecar fields when present.
CREATE TABLE txt_meta (
    txt_id   INTEGER PRIMARY KEY REFERENCES txt(id) ON DELETE CASCADE,
    metadata BLOB NOT NULL                         -- brotli(JSON)
);

-- One row per part. WITHOUT ROWID: table and index are one btree, and a
-- document's parts are physically adjacent in read order. path is the raw
-- 32 random bytes; base32-Crockford is applied when forming the object URL.
CREATE TABLE txt_parts (
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    path     BLOB    NOT NULL,
    PRIMARY KEY (txt_id, part_num)
) WITHOUT ROWID;

-- Read position. Its own table: it is the only continuously written data in BB.
CREATE TABLE txt_access (
    txt_id        INTEGER PRIMARY KEY REFERENCES txt(id) ON DELETE CASCADE,
    last_part_num INTEGER NOT NULL,
    last_accessed INTEGER NOT NULL                 -- unix ms
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num   INTEGER NOT NULL,
    line       INTEGER NOT NULL,
    preview    TEXT    NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 180),
    created_at INTEGER NOT NULL,                   -- unix ms, display only
    UNIQUE (txt_id, part_num, line)
);
CREATE INDEX idx_txt_bookmarks_txt_id ON txt_bookmarks(txt_id, id);

-- Per-document cap of 20, enforced in the database rather than in every caller.
-- Ordered by id: monotonic, and immune to client clock skew.
CREATE TRIGGER trg_txt_bookmarks_cap
AFTER INSERT ON txt_bookmarks
BEGIN
  DELETE FROM txt_bookmarks
  WHERE txt_id = NEW.txt_id
    AND id NOT IN (
      SELECT id FROM txt_bookmarks
      WHERE txt_id = NEW.txt_id
      ORDER BY id DESC
      LIMIT 20
    );
END;
```

`txt_access` carries no index on `last_accessed`; recency ordering is a client-side sort. `last_part_num` is clamped to `txt.n_parts` when a document is opened, which also covers a re-import that shortened the document.

### 7.1 Read position writes

Every commit dirties at least two pages — the changed leaf and page 1, whose change counter SQLite always bumps — so the floor is two objects, two `page_versions` rows, and one AA round trip. Read positions are therefore coalesced in memory and flushed as one upsert per document on whichever comes first: 10 seconds idle, document close, 20 page turns, or page-hide. Position held between flushes is soft state; losing the last interval means reopening one screen behind.

### 7.2 Document delete

One BB transaction deletes the `txt` row and cascades to `txt_meta`, `txt_parts`, `txt_access`, `txt_bookmarks`; the part keys are collected before the delete and their `t/` objects are deleted afterwards. A crash between the two leaves orphaned part objects, reclaimed by a sweep of `t/` against `txt_parts`.

---

## 8. Library index

A single-file SQLite database holding what the library UI needs before any document is opened. The client downloads it into OPFS and queries it locally; rendering the library requires one AA row read and one GET, with no BB open, no page map, and no SQLCipher.

### 8.1 Schema

```sql
PRAGMA page_size = 4096;

CREATE TABLE doc (
    txt_id   INTEGER PRIMARY KEY,          -- equals txt.id in BB
    title    TEXT    NOT NULL,
    sort_key TEXT
);

-- Authors, subjects and publishers are interned: a large library shares
-- a few thousand distinct terms.
CREATE TABLE term (
    id   INTEGER PRIMARY KEY,
    kind INTEGER NOT NULL,                 -- 1 author, 2 subject, 3 publisher
    name TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_term_kind_name ON term(kind, name);

CREATE TABLE doc_term (
    doc_id  INTEGER NOT NULL,
    kind    INTEGER NOT NULL,
    ord     INTEGER NOT NULL,              -- author order is meaningful
    term_id INTEGER NOT NULL,
    PRIMARY KEY (doc_id, kind, ord)
) WITHOUT ROWID;
CREATE INDEX idx_doc_term_term ON doc_term(term_id, doc_id);

CREATE TABLE built (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    index_schema     INTEGER NOT NULL,
    built_at_version INTEGER NOT NULL,
    built_at         INTEGER NOT NULL,
    doc_count        INTEGER NOT NULL
);
```

No foreign keys and no `AUTOINCREMENT`: the file is generated by one builder and never written by a client. Reading progress is not carried here — it changes on every page turn and comes from `txt_access` once BB is open.

### 8.2 Contract

`built_at_version = V` means the file is exactly the projection of BB's `txt` and `txt_meta` at version `V`. `txt_meta.metadata` is the source of truth; the index is derived, and discarding it is always safe. Staleness is therefore a comparison of two integers, and consistency is eventual and monotone: `built_at_version` only increases.

### 8.3 Write path

1. The client applies a metadata edit to its own OPFS copy immediately, so the UI is correct without waiting.
2. The edit is written to BB and committed (§6.2). This is the durability point.
3. The same AA batch sets `meta.index_dirty_at = V`, so an interrupted rebuild is resumed by whichever writer runs next.
4. A debounced builder — 10 seconds idle, 50 edits, or session end — runs after the commit, on a separate connection.
5. The builder pins a version (§6.1), scans `txt` and `txt_meta` at that version, and builds the file in memory. Pinning is required: an unpinned scan can produce a projection that matches no version of BB.
6. The file is `VACUUM`ed, brotli-compressed at quality 5, and encrypted under `HKDF(master_key, "library-index")` — never the SQLCipher page key.
7. The builder PUTs it to `library_index.object_key`, overwriting the previous object.
8. One AA batch updates `library_index` with the new `built_at_version`, `byte_size`, `doc_count`, `content_hash` and `built_at`, and clears `meta.index_dirty_at` if it has not advanced past `V`.

Only the writer builds the index, and only from BB. A crash before step 8 leaves an object whose contents are ahead of the pointer; the pointer still describes a self-consistent earlier state and the next rebuild replaces both.

### 8.4 Client read path

Read the `library_index` row from AA. If `built_at_version` and `content_hash` match the local OPFS copy's `built` row, use it and issue no GET. Otherwise GET the object, decrypt, decompress, and replace the OPFS copy atomically. A copy whose `index_schema` is unrecognised is discarded and re-fetched.

---

## 9. Concurrency

One writer per BB, enforced by the `versions.version` primary key rather than by a lease: there is nothing to expire, nothing to renew, and no stale-lease recovery path. Any number of readers may hold snapshots concurrently.

In-process, one write connection per BB is serialised by the VFS's advisory locks; readers on other connections read at their own pinned versions.

Across devices, concurrent reading is fully supported. Concurrent writing is not: the second committer loses the fence, reopens, and retries. Read-position flushes are coalesced (§7.1) partly to keep that collision rate low.

---

## 10. Properties and limits

- **Point-in-time reads.** A reader pinned at any retained version sees a stable view; the horizon is set by `gc_horizon`.
- **An opaque bucket.** R2/S3 holds unlabelled ciphertext at random keys, with no manifest object and no structure recoverable from a listing.
- **Durability.** `COMMIT` returns after the page objects are durable in R2/S3 and the AA batch is acknowledged. AA acknowledges only after its own durable write.
- **Latency.** Commit latency is bounded below by one round of PUTs plus one AA round trip. Steady-state reads are local map lookups plus a GET on cache miss.
- **Availability.** Writers require AA. Readers with a warm map continue serving cached and fetchable pages while AA is unreachable, and clients can render the library from OPFS.
- **AA sees metadata.** Page numbers, version numbers, random keys, sizes, and commit timing are visible to the provider; page content is not.
- **Metering.** AA bills rows read and written. The map load dominates per-session reads, so long-lived connections are strongly preferred over per-request ones.
- **Size ceiling.** Practical BB size is set by `page_map` memory and map-load time, in the low tens of gigabytes.

---

## 11. Build order

1. AA schema with the singleton check; a resolver tested against a synthetic AA.
2. Open, pin, warm, read without bundles.
3. Commit path as a single batch, with fault injection around the lost response.
4. The fence: two writers at `N+1`, exactly one succeeds, the loser reopens.
5. Snapshot pinning and GC together, including the pin/GC race.
6. Bundles: map section first, then hot pages, then the rebuild trigger.
7. BB schema and the `p/`, `t/`, `i/` prefix separation, with a test that the page orphan sweep leaves part objects untouched.
8. Read-position coalescing, with a dirty-page count assertion per commit as a regression test.
9. Library index: full rebuild on a pinned version, then the AA pointer and the client's version comparison.
10. Multi-database process concerns: memory governor, staggered GC and bundle rebuilds.
