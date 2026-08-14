```
s3://{bucket}/{db_prefix}/{txt.prefix}/{txt.path}
```

```sql
CREATE TABLE users (
  id         TEXT PRIMARY KEY,       -- Firebase uid (the ID token's sub claim)
  db_prefix  TEXT NOT NULL UNIQUE,   -- 32 random bytes; base32-Crockford
  created_at INTEGER NOT NULL        -- unix ms
);
```

```sql
CREATE TABLE txt (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_key    BLOB    NOT NULL,                   -- 128 random bytes
    txt_prefix     BLOB    NOT NULL,               -- 32 random bytes; base32-Crockford
    name       TEXT    NOT NULL,                   -- original filename
    metadata   BLOB    NOT NULL,                   -- brotli(JSON)
    catalog    BLOB    NOT NULL                    -- brotli(JSON)
    path       BLOB    NOT NULL,                   -- 32 random bytes; base32-Crockford
    last_accessed INTEGER NOT NULL,                -- unix ms
    created_at INTEGER NOT NULL                    -- unix ms
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    line       INTEGER NOT NULL,
    preview    TEXT    NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 180),
    created_at INTEGER NOT NULL,                   -- unix ms, display only
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