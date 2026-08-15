# Data Model — Design

Each user, as provisioned in docs/auth.md, has exactly one SQLCipher database: a single file in R2 at `s3://{bucket}/{db_path}`. The client downloads it, opens it locally with `db_master_key`, reads and writes it there, and — if anything changed — uploads it back to the same key. There is no live database connection: the file is the database.

A document's own content is not in that file. Each document is a separate encrypted object in R2, referenced by a row in the `txt` table.

---

## 1. Where things live

`db_path`, `db_prefix`, and `db_master_key` (256 random bytes, base64-encoded — the SQLCipher key for the file in §1) all come from `ctl` (docs/auth.md §2 and §5): the client recovers them by decrypting its `cred_store.content` after `/v1/keys`, and uses `db_prefix` to mint an R2 credential via `/v1/r2-token`.

```
s3://{bucket}/{db_path}
s3://{bucket}/{db_prefix}/{txt.txt_prefix}/{txt.path}
```

The first is the user's whole SQLCipher database — one object, downloaded whole and uploaded whole. The second is one document's content — one object per `txt` row, addressed by that row's own `txt_prefix`/`path` columns rather than by `id`, so listing or guessing one document's key reveals nothing about any other. Both `txt_prefix` and `path` are raw random bytes in the database and rendered as base32-Crockford strings when used as key segments, the same recipe as `db_path`/`db_prefix` (docs/auth.md).

`{bucket}` is not a secret — it comes from the client's own local config, alongside the R2 endpoint and region.

---

## 2. The read-write round trip

1. The client authenticates and obtains `db_path`, `db_prefix`, `db_master_key`, and an R2 credential (docs/auth.md).
2. It downloads `s3://{bucket}/{db_path}` and opens it with `db_master_key`. If no object exists yet at that key, the client creates a fresh database from the schema below instead.
3. It reads and writes the database locally — querying `txt`, adding or trimming `txt_bookmarks`, downloading and decrypting individual documents' content objects on demand.
4. If anything changed, it uploads the file back to `s3://{bucket}/{db_path}`, overwriting the previous version.

There is exactly one writer at a time by construction: the R2 credential from §1 is the only path to the file, and nothing else in this design opens it concurrently.

---

## 3. Schema

```sql
CREATE TABLE txt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_key       BLOB    NOT NULL,   -- 128 random bytes; the AEAD key for this document's content object
    txt_prefix    BLOB    NOT NULL,   -- 32 random bytes; first key segment of the content object (§1)
    path          BLOB    NOT NULL,   -- 32 random bytes; second key segment of the content object (§1)
    metadata      BLOB    NOT NULL,   -- brotli(JSON): original filename plus opf sidecar passthrough (§3.1)
    last_accessed INTEGER NOT NULL,   -- unix ms
    created_at    INTEGER NOT NULL    -- unix ms
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    line       INTEGER NOT NULL,
    preview    TEXT    NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 180),
    created_at INTEGER NOT NULL,   -- unix ms, display only
    UNIQUE (txt_id, line)
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

### 3.1 `metadata`

`name` is the original filename, not from the sidecar. The nested `metadata` key is the ingested document's OPF sidecar, parsed as-is when one exists — title, authors, subjects, publishers, and whatever else it carries all live there under the OPF format's own field names, rather than duplicated as separate columns:

```json
{
  "name": "original filename",
  "metadata": { "...": "opf sidecar fields, when present" }
}
```

The whole file is already encrypted by SQLCipher under `db_master_key`, so `metadata` is only brotli-compressed, not separately encrypted — there is no second key for it to be wrapped under.

`txt_key` is unrelated to `db_master_key`: it is the AEAD key for one document's content object, generated fresh per document, so leaking one document's key exposes nothing about any other document or about the database file itself.

`txt_bookmarks.line` is the line number a bookmark points to inside the document; `preview` is a short excerpt shown alongside it, capped at 180 bytes rather than 180 characters (`CAST(... AS BLOB)`) since a UTF-8 character can be up to 4 bytes. `UNIQUE (txt_id, line)` means re-bookmarking the same line replaces the existing bookmark rather than duplicating it.

`trg_txt_bookmarks_cap` keeps at most 20 bookmarks per document, deleting the oldest by `id` — `id` is monotonic and assigned locally, so the cap is immune to client clock skew in a way a `created_at`-ordered cap would not be. `idx_txt_bookmarks_txt_id` supports listing one document's bookmarks, and the cap's own subquery, without a table scan.

---

## 4. Build order

1. The SQLCipher round trip: download, open with `db_master_key`, read, close, re-upload only on change.
2. `txt` and search/sort/browse over `metadata`.
3. Per-document content: `txt_key`/`txt_prefix`/`path`, fetching and decrypting one document's object from R2.
4. `txt_bookmarks`, its cap trigger, and the supporting index.
