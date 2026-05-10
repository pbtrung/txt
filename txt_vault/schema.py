from .constants import BOOKMARK_LIMIT

_SCHEMA = """
CREATE TABLE IF NOT EXISTS txt (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      BLOB NOT NULL,
    name_hmac BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    content  BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id_part_num ON txt_parts(txt_id, part_num);
CREATE TABLE IF NOT EXISTS part_count (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_access (
    txt_id        INTEGER PRIMARY KEY REFERENCES txt(id) ON DELETE CASCADE,
    last_part_num INTEGER NOT NULL DEFAULT 1,
    last_accessed INTEGER NOT NULL
);
"""

# Stored as a list to avoid splitting the trigger body on semicolons.
_BOOKMARKS_STMTS = [
    """
    CREATE TABLE IF NOT EXISTS bookmarks (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
        bookmark BLOB NOT NULL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_bookmarks_txt_id
        ON bookmarks(txt_id)
    """,
    f"""
    CREATE TRIGGER IF NOT EXISTS trg_limit_bookmarks_per_file
    BEFORE INSERT ON bookmarks
    WHEN (SELECT COUNT(*) FROM bookmarks WHERE txt_id = NEW.txt_id) >= {BOOKMARK_LIMIT}
    BEGIN
        DELETE FROM bookmarks
        WHERE id = (
            SELECT id FROM bookmarks
            WHERE txt_id = NEW.txt_id
            ORDER BY id ASC
            LIMIT 1
        );
    END
    """,
]
