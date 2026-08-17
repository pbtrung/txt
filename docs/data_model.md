# Data Model — Design

Each user, as provisioned in docs/auth.md, has exactly one SQLCipher database: a single file in R2 at `s3://{bucket}/{db_path}`. The client downloads it, opens it locally with `db_master_key`, reads and writes it there, and — if anything changed — uploads it back to the same key. There is no live database connection: the file is the database.

A document's own content is not in that file. Each document is a separate encrypted object in R2, referenced by a row in the `txt` table.

---

## 1. Where things live

`db_path`, `db_prefix`, and `db_master_key` (256 random bytes, base64-encoded — the SQLCipher key for the file in §1) all come from `ctl` (docs/auth.md §2 and §5): the client recovers them by decrypting its `cred_store.content` after `/v1/keys`, then submits the two paths to `/v1/r2-token` for ownership verification and scoped R2 credentials.

```
s3://{bucket}/{db_path}
s3://{bucket}/{db_prefix}/{txt.txt_prefix}/{txt.path}
```

The first is the user's whole SQLCipher database — one object, downloaded and conditionally uploaded as a whole with the exact-`db_path` read-write credential. The second is one immutable document-content object per `txt` row, fetched with the `{db_prefix}/*` read-only credential and addressed by that row's own `txt_prefix`/`path` columns rather than by `id`, so listing or guessing one document's key reveals nothing about any other. Both `txt_prefix` and `path` are raw random bytes in the database and rendered as base32-Crockford strings when used as key segments, the same recipe as `db_path`/`db_prefix` (docs/auth.md).

`{bucket}` is not a secret, but the client carries no R2 connection details of its own — `bucket`, along with the endpoint and region, travels in the `/v1/r2-token` response itself (docs/auth.md §4.2), the client's only source of R2 configuration.

---

## 2. The read-write round trip

1. The client authenticates and obtains `db_path`, `db_prefix`, `db_master_key`, an exact-`db_path` read-write credential, and a `{db_prefix}/*` read-only credential (docs/auth.md).
2. It downloads `s3://{bucket}/{db_path}` without HTTP caching and retains the response `ETag` alongside the bytes. If no object exists yet at that key, it creates a fresh database from the schema below and records that the next upload is a create.
3. It opens the database with `db_master_key`, reapplies `PRAGMA page_size = 16384` before the first schema access, and runs the idempotent schema check.
4. It reads document metadata and reading state locally. Document content is downloaded and decrypted separately through the read-only prefix credential.
5. A reading-state change is represented as a semantic mutation — update last access/location, add or remove a bookmark — and serialized through one write queue in the page. The mutation runs in a SQLite transaction.
6. The client uploads the whole encrypted database with `If-Match: <downloaded ETag>`. Creating a previously absent database uses `If-None-Match: *`. A successful response supplies the new current `ETag`.
7. `412 PreconditionFailed` means another tab or device committed first. The client downloads and opens the latest database, reapplies the same semantic mutation, and retries with the new `ETag`, up to a bounded limit. It never merges encrypted bytes or blindly overwrites the winner.

R2 is the durable source of truth; the browser's open database is only a working copy. The in-page queue prevents overlapping writes from one session, while the conditional upload prevents lost updates across tabs and devices. If a write still cannot be committed after bounded retries, the UI keeps it visibly unsaved and offers retry rather than claiming success. Credential expiry is handled before retrying data operations: the client refreshes both temporary credentials through `/v1/r2-token` and does not treat an authorization failure as a database conflict.

---

## 3. Schema

The database's persisted page size is fixed at 16 KiB when a fresh database is created (§2 step 2). Because SQLCipher encrypts page 1, every connection must still issue `PRAGMA page_size = 16384` immediately after applying the key and before its first schema read; on an existing database this configures the connection rather than rewriting the file:

```sql
PRAGMA page_size = 16384;

CREATE TABLE txt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_key       BLOB    NOT NULL,   -- 128 random bytes; the AEAD key for this document's content object
    txt_prefix    BLOB    NOT NULL,   -- 32 random bytes; first key segment of the content object (§1)
    path          BLOB    NOT NULL,   -- 32 random bytes; second key segment of the content object (§1)
    catalog       BLOB    NOT NULL,   -- brotli(JSON): {name, title, authors, subjects, publisher} (§3.1)
    last_accessed INTEGER NOT NULL,   -- unix ms; set after the Reader's six-second grace period
    last_cfi      TEXT,               -- last stable EPUB CFI reported by the rendition, null until first location
    created_at    INTEGER NOT NULL    -- unix ms
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    cfi        TEXT    NOT NULL,
    preview    TEXT    NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 100),
    created_at INTEGER NOT NULL,   -- unix ms, display only
    UNIQUE (txt_id, cfi)
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

### 3.1 `catalog`

A fixed, flat shape — just what the Library screen needs to search and browse without opening every document:

```json
{
  "name": "original filename",
  "title": "the OPF sidecar's dc:title, or name if there wasn't one",
  "authors": ["every dc:creator, in order"],
  "subjects": ["every dc:subject, in order"],
  "publisher": "the OPF sidecar's dc:publisher, or null"
}
```

`name` is the original filename, not from the sidecar. Anything else the sidecar carries (description, language, series, whatever else Calibre wrote) isn't kept here — every valid EPUB already carries the same core fields in its own internal package document, so the Reader gets full metadata by parsing that directly once it has the document's bytes in hand, rather than this column duplicating it.

The whole file is already encrypted by SQLCipher under `db_master_key`, so `catalog` is only brotli-compressed, not separately encrypted — there is no second key for it to be wrapped under.

### 3.2 Reading state and bookmarks

An open becomes a qualifying reading session only after the Reader has successfully loaded the document and remained visible for six seconds. The timer pauses while the page is hidden. Until the grace period completes, rendition relocation events update only an in-memory CFI candidate; closing the Reader or switching books discards that candidate without changing `last_accessed` or `last_cfi`. The initial relocation event establishes the candidate position but never marks the database dirty by itself.

When the grace period completes, one semantic mutation sets `last_accessed` for recent-book sorting and stores the latest stable CFI in `last_cfi`. After that, user-driven relocation events update `last_cfi` after a two-second debounce. Reading-state mutations are coalesced and uploaded at most once every 15 seconds to avoid replacing the whole database on every page turn. The client attempts a final flush when the page becomes hidden or the Reader switches books, but only for a session that passed the grace period; correctness does not depend solely on an unload-time request.

An EPUB Canonical Fragment Identifier (CFI) identifies a content position independently of viewport width, font size, column count, and generated page numbering. Page and line numbers are therefore presentation only and are never persisted. On open, a non-null `last_cfi` is passed to the renderer's `display(cfi)`; an invalid CFI falls back to the beginning without discarding the rest of the database.

A manual bookmark stores the current page-start CFI and a short nearby plain-text preview. A future text-selection bookmark may store the CFI range emitted by the renderer without changing the schema. Re-bookmarking the same `(txt_id, cfi)` updates its preview and display timestamp rather than adding a duplicate. Bookmark creation and deletion are uploaded immediately; deletion is replayed by `(txt_id, cfi)` during conflict recovery rather than by local numeric `id`.

`preview` is capped at 100 UTF-8 bytes rather than 100 characters (`CAST(... AS BLOB)`), since one character can occupy up to four bytes. `trg_txt_bookmarks_cap` keeps at most 20 bookmarks per document, deleting the oldest by `id`. `AUTOINCREMENT` makes that ordering monotonic even after manual deletions and avoids relying on client clocks. `idx_txt_bookmarks_txt_id` supports listing one document's bookmarks and the cap trigger without a table scan.

The EPUB content object referenced by a `txt` row is immutable. That makes a structural CFI sufficient even when the renderer does not emit optional text-location assertions. Replacing a book creates a new content object/row rather than silently changing the document underneath saved CFIs.

### 3.3 Migration

Migration is driven by inspecting the tables, columns, indexes, and triggers that are actually present. Fresh databases are created directly from the complete schema above; existing databases receive only the missing changes.

`txt --update-db admin_creds.json --local-db-dir DIR --verbose` migrates every reachable database transactionally and idempotently before the writing UI is deployed:

1. If `txt.metadata` is present, add and populate `catalog`, then drop `metadata` as in the existing catalog migration.
2. Add nullable `txt.last_cfi` when absent; existing `last_accessed` values remain valid.
3. If the legacy `txt_bookmarks(line, ...)` table exists, require it to be empty because a line number cannot be converted reliably to a CFI, then replace it with the CFI table, index, and trigger above. A nonempty legacy table aborts that account rather than losing data.
4. `VACUUM`, write the local checkpoint, and upload the database only after every step succeeds.

The command reaches every account through the administrator-owned backup `cred_store` row guaranteed by docs/auth.md. It verifies that every `users` row has a decryptable backup before making changes, resumes safely after interruption, and re-uploads an already-migrated local file when the preceding remote upload may not have completed. Deployment also backfills the `users.db_path_hash`/`db_prefix_hash` authorization bindings from the same decrypted payloads before the new token endpoint is enabled.

`txt_key` is unrelated to `db_master_key`: it is the AEAD key for one document's content object, generated fresh per document, so leaking one document's key exposes nothing about any other document or about the database file itself.

---

## 4. Build order

1. Provision and backfill the `ctl` path hashes in docs/auth.md before any browser receives database write access.
2. Migrate the SQLCipher schema through `--update-db`; deploy this safely before the writing UI because the existing read-only UI ignores the added column and CFI bookmark table.
3. Return and parse the separate `db_path` read-write and `db_prefix` read-only credentials, including refresh and R2 CORS support for `PUT`, `If-Match`, `If-None-Match`, and exposed `ETag`.
4. Introduce the browser database store: no-cache GET plus `ETag`, one mutation queue, conditional PUT, conflict reload/replay, bounded retries, and explicit unsaved state.
5. Apply the six-second visible-reading grace period, then update `last_accessed` and persist/resume debounced `last_cfi` values from renderer relocation events.
6. Add CFI bookmark creation, listing, navigation, deletion, preview generation, and saved/error UI.
7. Test migration states, credential scope, path mismatch rejection, credential refresh, two-client conflicts, CFI reflow stability, and bookmark-cap behavior before deployment.
