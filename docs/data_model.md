# Data model

This document describes the database schema: the tables, their
relationships, and the on-disk shape of the content they hold.

## Schema

```sql
CREATE TABLE IF NOT EXISTS txt (
    id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE TABLE IF NOT EXISTS txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    content  BLOB    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id_part_num ON txt_parts(txt_id, part_num);

CREATE TABLE IF NOT EXISTS txt_access (
    txt_id        INTEGER PRIMARY KEY REFERENCES txt(id) ON DELETE CASCADE,
    last_part_num INTEGER NOT NULL DEFAULT 1,
    last_accessed INTEGER NOT NULL      -- Unix timestamp in milliseconds
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    bookmark BLOB    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_txt_id ON bookmarks(txt_id);

CREATE TRIGGER IF NOT EXISTS trg_limit_bookmarks_per_file
BEFORE INSERT ON bookmarks
WHEN (SELECT COUNT(*) FROM bookmarks WHERE txt_id = NEW.txt_id) >= 20
BEGIN
    DELETE FROM bookmarks
    WHERE id = (
        SELECT id FROM bookmarks
        WHERE txt_id = NEW.txt_id
        ORDER BY id ASC LIMIT 1
    );
END;

CREATE TABLE IF NOT EXISTS txt_metadata (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    content BLOB    NOT NULL
);
```

## Tables

### `txt`

One row per document. `id` is the document's identity; every other table
hangs off `txt_id`. The table carries no other columns of its own — title,
size, and other descriptive fields live in `txt_metadata`.

### `txt_parts`

A document's body, chunked into ordered parts. `content` is the part's
payload, brotli-compressed. `(txt_id, part_num)` is indexed to support
fetching a specific part or a contiguous range without a table scan;
`part_num` numbering and gaps are left to the application.

### `txt_access`

Reading position within a document: `last_part_num` is the part last
reached, `last_accessed` the time of that access (Unix ms). `txt_id` is the
primary key — one position per document, upserted in place as reading
progresses.

### `bookmarks`

Saved positions/annotations within a document. `bookmark` is
brotli-compressed JSON — the JSON shape (e.g. offset, label, note) is an
application-level concern, not enforced by the schema. `idx_bookmarks_txt_id`
supports listing a document's bookmarks.

`trg_limit_bookmarks_per_file` caps each `txt_id` at 20 rows: on insert past
the cap, it evicts the lowest-`id` row for that document before the new one
lands, i.e. FIFO — oldest bookmark dropped first.

### `txt_metadata`

A singleton table: exactly one row, enforced by `CHECK (id = 1)`. `content`
is brotli-compressed JSON metadata covering all `txt` documents (the JSON
shape is not yet defined).

## Compression

Three columns hold brotli-compressed payloads:

| Column                  | Pre-compression payload |
|--------------------------|--------------------------|
| `txt_parts.content`      | raw bytes (document text) |
| `bookmarks.bookmark`     | JSON |
| `txt_metadata.content`   | JSON |

`txt_parts.content` compresses the document body directly; `bookmarks.bookmark`
and `txt_metadata.content` compress a JSON document first, then brotli the
result. In every case the database sees only the compressed BLOB — it has no
visibility into the underlying text or JSON structure.

## Relationships

```
txt (1) ──< txt_parts (N)
txt (1) ──1 txt_access
txt (1) ──< bookmarks (N, ≤20)
```

`txt_metadata` is not tied to any particular `txt` row — it's a single,
standalone blob covering all documents.
