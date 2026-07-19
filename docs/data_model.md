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

### `txt_metadata`

A singleton table: exactly one row, enforced by `CHECK (id = 1)`. `content`
is brotli-compressed JSON metadata covering all `txt` documents (the JSON
shape is not yet defined).

## Compression

Two columns hold brotli-compressed payloads:

| Column                  | Pre-compression payload |
|--------------------------|--------------------------|
| `txt_parts.content`      | raw bytes (document text) |
| `txt_metadata.content`   | JSON |

`txt_parts.content` compresses the document body directly; `txt_metadata.content`
compresses a JSON document first, then brotli the result. In every case the
database sees only the compressed BLOB — it has no visibility into the
underlying text or JSON structure.

## Relationships

```
txt (1) ──< txt_parts (N)
```

`txt_metadata` is not tied to any particular `txt` row — it's a single,
standalone blob covering all documents.
