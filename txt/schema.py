"""Turso schema DDL (see docs/data_model.md).

Every ON DELETE CASCADE below is inert in practice: txt/db.py never issues
`PRAGMA foreign_keys = ON`, and libsql/SQLite treats foreign keys as
unenforced (cascades included) unless that pragma is set for the connection.
txt/delete.py deletes each dependent row explicitly for this reason (see its
own docstring/comments). The clauses are kept here as documentation of the
intended relationships, not as something the DB itself will act on.
"""

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
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    txt_access_key BLOB    NOT NULL,
    access         BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS bookmarks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    bookmark_key BLOB    NOT NULL,
    bookmark     BLOB    NOT NULL
);
CREATE TABLE IF NOT EXISTS txt_metadata (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    txt_metadata_key BLOB    NOT NULL,
    content          BLOB
);
"""


def statements() -> list[str]:
    """All DDL statements to apply, in order."""
    return [s.strip() for s in _TABLES.strip().split(";") if s.strip()]
