from contextlib import contextmanager
from dataclasses import dataclass

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

CREATE_TXT_BOOKMARKS_INDEX_SQL = (
    "CREATE INDEX IF NOT EXISTS idx_txt_bookmarks_txt_id ON txt_bookmarks(txt_id, id)"
)

CREATE_TXT_BOOKMARKS_CAP_TRIGGER_SQL = """
CREATE TRIGGER IF NOT EXISTS trg_txt_bookmarks_cap
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
END
"""

REQUIRED_TXT_COLUMNS = {
    "id",
    "txt_key",
    "txt_prefix",
    "path",
    "catalog",
    "last_accessed",
    "last_cfi",
    "created_at",
}
REQUIRED_BOOKMARK_COLUMNS = {
    "id",
    "txt_id",
    "cfi",
    "page_number",
    "preview",
    "created_at",
}


@dataclass(frozen=True)
class SchemaStats:
    txt_rows: int
    bookmarks: int


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


def table_exists(engine: SqliteEngine, name: str) -> bool:
    return bool(
        engine.query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]
        )
    )


def table_columns(engine: SqliteEngine, name: str) -> set[str]:
    return {row[1] for row in engine.query(f"PRAGMA table_info({name})")}


def object_sql(engine: SqliteEngine, kind: str, name: str) -> str:
    rows = engine.query(
        "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?", [kind, name]
    )
    return rows[0][0] if rows and isinstance(rows[0][0], str) else ""


def compact_sql(sql: str) -> str:
    return "".join(sql.lower().split())


def ensure_database_schema(engine: SqliteEngine) -> bool:
    configure_database(engine)
    engine.exec_sql(CREATE_TXT_SQL)
    return ensure_reading_schema(engine)


def ensure_reading_schema(
    engine: SqliteEngine, *, manage_transaction: bool = True
) -> bool:
    if manage_transaction:
        engine.exec_sql("BEGIN IMMEDIATE")
    try:
        changed = _ensure_reading_objects(engine)
        if manage_transaction:
            engine.exec_sql("COMMIT")
        return changed
    except Exception:
        if manage_transaction:
            engine.exec_sql("ROLLBACK")
        raise


def _ensure_reading_objects(engine: SqliteEngine) -> bool:
    changed = _ensure_last_cfi(engine)
    changed = _ensure_bookmark_table(engine) or changed
    changed = _ensure_bookmark_page_number(engine) or changed
    changed = _ensure_bookmark_support(engine) or changed
    return changed


def _ensure_last_cfi(engine: SqliteEngine) -> bool:
    if "last_cfi" in table_columns(engine, "txt"):
        return False
    engine.exec_sql("ALTER TABLE txt ADD COLUMN last_cfi TEXT")
    return True


def _ensure_bookmark_table(engine: SqliteEngine) -> bool:
    if not table_exists(engine, "txt_bookmarks"):
        engine.exec_sql(CREATE_TXT_BOOKMARKS_SQL)
        return True
    columns = table_columns(engine, "txt_bookmarks")
    if "line" in columns:
        _replace_legacy_bookmarks(engine)
        return True
    if "cfi" not in columns:
        raise ValueError("txt_bookmarks has an unsupported schema")
    return False


def _ensure_bookmark_page_number(engine: SqliteEngine) -> bool:
    if "page_number" in table_columns(engine, "txt_bookmarks"):
        return False
    engine.exec_sql(
        "ALTER TABLE txt_bookmarks ADD COLUMN page_number INTEGER "
        "CHECK (page_number IS NULL OR page_number >= 1)"
    )
    return True


def _replace_legacy_bookmarks(engine: SqliteEngine) -> None:
    [(count,)] = engine.query("SELECT count(*) FROM txt_bookmarks")
    if count:
        raise ValueError(
            "legacy txt_bookmarks contains line bookmarks; "
            "cannot migrate them safely to EPUB CFIs"
        )
    engine.exec_sql("DROP TRIGGER IF EXISTS trg_txt_bookmarks_cap")
    engine.exec_sql("DROP INDEX IF EXISTS idx_txt_bookmarks_txt_id")
    engine.exec_sql("DROP TABLE txt_bookmarks")
    engine.exec_sql(CREATE_TXT_BOOKMARKS_SQL)


def _ensure_bookmark_support(engine: SqliteEngine) -> bool:
    index_missing = not _object_exists(engine, "index", "idx_txt_bookmarks_txt_id")
    trigger_missing = not _object_exists(engine, "trigger", "trg_txt_bookmarks_cap")
    engine.exec_sql(CREATE_TXT_BOOKMARKS_INDEX_SQL)
    engine.exec_sql(CREATE_TXT_BOOKMARKS_CAP_TRIGGER_SQL)
    return index_missing or trigger_missing


def _object_exists(engine: SqliteEngine, kind: str, name: str) -> bool:
    return bool(
        engine.query(
            "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?", [kind, name]
        )
    )


def validate_schema(engine: SqliteEngine) -> SchemaStats:
    errors = []
    _validate_pragmas(engine, errors)
    _validate_txt(engine, errors)
    _validate_bookmarks(engine, errors)
    _validate_integrity(engine, errors)
    if errors:
        raise ValueError("schema validation failed: " + "; ".join(errors))
    return SchemaStats(_row_count(engine, "txt"), _row_count(engine, "txt_bookmarks"))


def _validate_pragmas(engine: SqliteEngine, errors: list[str]) -> None:
    [(page_size,)] = engine.query("PRAGMA page_size")
    [(foreign_keys,)] = engine.query("PRAGMA foreign_keys")
    if int(page_size) != PAGE_SIZE:
        errors.append(f"page_size is {page_size}, expected {PAGE_SIZE}")
    if int(foreign_keys) != 1:
        errors.append("foreign_keys is not enabled")


def _validate_txt(engine: SqliteEngine, errors: list[str]) -> None:
    columns = table_columns(engine, "txt")
    _append_missing_columns(errors, "txt", REQUIRED_TXT_COLUMNS - columns)
    if "metadata" in columns:
        errors.append("txt.metadata still exists")
    if "autoincrement" not in compact_sql(object_sql(engine, "table", "txt")):
        errors.append("txt.id is not AUTOINCREMENT")
    null_catalogs = _null_catalog_count(engine) if "catalog" in columns else 0
    if null_catalogs:
        errors.append(f"txt has {null_catalogs} null catalog value(s)")


def _validate_bookmarks(engine: SqliteEngine, errors: list[str]) -> None:
    columns = table_columns(engine, "txt_bookmarks")
    missing = REQUIRED_BOOKMARK_COLUMNS - columns
    _append_missing_columns(errors, "txt_bookmarks", missing)
    if "line" in columns:
        errors.append("txt_bookmarks.line still exists")
    _validate_bookmark_sql(engine, errors)
    _validate_bookmark_support(engine, errors)


def _validate_bookmark_sql(engine: SqliteEngine, errors: list[str]) -> None:
    sql = compact_sql(object_sql(engine, "table", "txt_bookmarks"))
    checks = {
        "autoincrement": "txt_bookmarks.id is not AUTOINCREMENT",
        "unique(txt_id,cfi)": "txt_bookmarks is missing UNIQUE(txt_id, cfi)",
        "page_numberisnullorpage_number>=1": (
            "txt_bookmarks is missing the positive page-number constraint"
        ),
        "length(cast(previewasblob))<=100": (
            "txt_bookmarks is missing the 100-byte preview limit"
        ),
    }
    errors.extend(
        message for fragment, message in checks.items() if fragment not in sql
    )


def _validate_bookmark_support(engine: SqliteEngine, errors: list[str]) -> None:
    index_columns = [
        row[2] for row in engine.query("PRAGMA index_info(idx_txt_bookmarks_txt_id)")
    ]
    if index_columns != ["txt_id", "id"]:
        errors.append("idx_txt_bookmarks_txt_id has the wrong columns")
    trigger = compact_sql(object_sql(engine, "trigger", "trg_txt_bookmarks_cap"))
    if "orderbyiddesc" not in trigger or "limit20" not in trigger:
        errors.append("trg_txt_bookmarks_cap does not enforce the newest-20 cap")
    if not _has_bookmark_foreign_key(engine):
        errors.append("txt_bookmarks is missing its cascading txt foreign key")


def _has_bookmark_foreign_key(engine: SqliteEngine) -> bool:
    rows = engine.query("PRAGMA foreign_key_list(txt_bookmarks)")
    return any(
        len(row) >= 7
        and tuple(row[2:5]) == ("txt", "txt_id", "id")
        and str(row[6]).upper() == "CASCADE"
        for row in rows
    )


def _validate_integrity(engine: SqliteEngine, errors: list[str]) -> None:
    result = [str(row[0]) for row in engine.query("PRAGMA quick_check")]
    if result != ["ok"]:
        errors.append("database quick_check failed: " + "; ".join(result))


def _append_missing_columns(errors: list[str], table: str, missing: set[str]) -> None:
    if missing:
        errors.append(f"{table} missing columns: {', '.join(sorted(missing))}")


def _null_catalog_count(engine: SqliteEngine) -> int:
    [(count,)] = engine.query("SELECT count(*) FROM txt WHERE catalog IS NULL")
    return int(count)


def _row_count(engine: SqliteEngine, table: str) -> int:
    [(count,)] = engine.query(f"SELECT count(*) FROM {table}")
    return int(count)
