"""Turso schema DDL (see docs/data_model.md)."""

from .constants import BOOKMARK_LIMIT

_TABLES = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username_hash BLOB NOT NULL UNIQUE,
    pw_salt       BLOB NOT NULL,
    pw_hash       BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS umk_store (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    umk     BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS key_store (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    pub_key  BLOB    NOT NULL,
    priv_key BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS r2_config (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    config  BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS txt (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    txt_key BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    path     BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_shares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id        INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    to_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    salt_kem_ct   BLOB    NOT NULL,
    txt_key       BLOB    NOT NULL,
    UNIQUE (txt_id, to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_txt_parts_txt_id_part_num ON txt_parts(txt_id, part_num);
CREATE TABLE IF NOT EXISTS part_count (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id INTEGER NOT NULL UNIQUE REFERENCES txt(id) ON DELETE CASCADE,
    count  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_access (
    txt_id  INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access  BLOB NOT NULL,
    PRIMARY KEY (txt_id, user_id)
);
CREATE TABLE IF NOT EXISTS bookmarks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bookmark BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_txt_id_user_id ON bookmarks(txt_id, user_id);
CREATE TABLE IF NOT EXISTS txt_metadata (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    txt_metadata_key BLOB    NOT NULL,
    content          BLOB
);
"""

# Kept out of _TABLES and un-split-by-";" since the trigger body contains semicolons.
_TRIGGER = f"""
CREATE TRIGGER IF NOT EXISTS trg_limit_bookmarks_per_file
BEFORE INSERT ON bookmarks
WHEN (SELECT COUNT(*) FROM bookmarks WHERE txt_id = NEW.txt_id AND user_id = NEW.user_id) >= {BOOKMARK_LIMIT}
BEGIN
    DELETE FROM bookmarks
    WHERE id = (
        SELECT id FROM bookmarks
        WHERE txt_id = NEW.txt_id AND user_id = NEW.user_id
        ORDER BY id ASC LIMIT 1
    );
END
"""


def statements() -> list[str]:
    """All DDL statements to apply, in order."""
    return [s.strip() for s in _TABLES.strip().split(";") if s.strip()] + [
        _TRIGGER.strip()
    ]
