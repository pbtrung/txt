// docs/data_model.md §3, ported from txt/ingest.py's own SQL constants --
// the schema a client applies to a freshly created database, and reapplies
// (idempotently, IF NOT EXISTS) on every open regardless.
export const PAGE_SIZE = 16384; // 16 KiB

// Fixed at creation; reissuing here on every open is required, not just
// harmless -- SQLCipher's page-1 salt overwrites the bytes SQLite would
// otherwise auto-detect the page size from, so a connection that never
// reissues this pragma silently falls back to the compiled-in default.
const SET_PAGE_SIZE_SQL = `PRAGMA page_size = ${PAGE_SIZE}`;

const CREATE_TXT_SQL = `
CREATE TABLE IF NOT EXISTS txt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_key BLOB NOT NULL,
  txt_prefix BLOB NOT NULL,
  path BLOB NOT NULL,
  metadata BLOB NOT NULL,
  last_accessed INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)
`;

const CREATE_TXT_BOOKMARKS_SQL = `
CREATE TABLE IF NOT EXISTS txt_bookmarks (
  id INTEGER PRIMARY KEY,
  txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  preview TEXT NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 180),
  created_at INTEGER NOT NULL,
  UNIQUE (txt_id, line)
)
`;

const CREATE_TXT_BOOKMARKS_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_txt_bookmarks_txt_id ON txt_bookmarks(txt_id, id)";

const CREATE_TXT_BOOKMARKS_CAP_TRIGGER_SQL = `
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
`;

export interface Executable {
  execSql(sql: string): void;
}

export function ensureSchema(db: Executable): void {
  for (const stmt of [
    SET_PAGE_SIZE_SQL,
    CREATE_TXT_SQL,
    CREATE_TXT_BOOKMARKS_SQL,
    CREATE_TXT_BOOKMARKS_INDEX_SQL,
    CREATE_TXT_BOOKMARKS_CAP_TRIGGER_SQL,
  ]) {
    db.execSql(stmt);
  }
}
