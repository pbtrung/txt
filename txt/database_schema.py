"""The predecessor design's whole-file SQLCipher schema (`txt`,
`txt_bookmarks`) -- kept only so `migrate_rql.py` can open and read a
not-yet-migrated deployment's database. Schema installation/migration
for that design no longer happens here; the D1 design's schema is
Worker-managed (`wrangler d1 migrations`)."""

from contextlib import contextmanager

from .sqlite_engine import SqliteEngine

PAGE_SIZE = 16384
SET_PAGE_SIZE_SQL = f"PRAGMA page_size = {PAGE_SIZE}"
ENABLE_FOREIGN_KEYS_SQL = "PRAGMA foreign_keys = ON"

CREATE_TXT_SQL = """
CREATE TABLE IF NOT EXISTS txt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_key BLOB NOT NULL,
  txt_prefix BLOB NOT NULL,
  path BLOB NOT NULL,
  catalog BLOB NOT NULL,
  last_accessed INTEGER NOT NULL,
  last_cfi TEXT,
  created_at INTEGER NOT NULL
)
"""

CREATE_TXT_BOOKMARKS_SQL = """
CREATE TABLE IF NOT EXISTS txt_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
  cfi TEXT NOT NULL,
  page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
  preview TEXT NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 100),
  created_at INTEGER NOT NULL,
  UNIQUE (txt_id, cfi)
)
"""


def configure_database(engine: SqliteEngine) -> None:
    configure_page_size(engine)
    engine.exec_sql(ENABLE_FOREIGN_KEYS_SQL)


def configure_page_size(engine: SqliteEngine) -> None:
    engine.exec_sql(SET_PAGE_SIZE_SQL)


@contextmanager
def open_database(
    key: bytes,
    data: bytes | None,
    *,
    engine_factory=SqliteEngine,
    configure=configure_database,
):
    engine = engine_factory()
    try:
        engine.open(key, initial_bytes=data)
        configure(engine)
        yield engine
    finally:
        engine.close()
