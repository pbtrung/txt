// docs/data_model.md §3, ported from txt/ingest.py's own SQL constants --
// the schema a client applies to a freshly created database, and reapplies
// (idempotently, IF NOT EXISTS) on every open regardless.
export const PAGE_SIZE = 16384; // 16 KiB

// Fixed at creation; reissuing here on every open is required, not just
// harmless -- SQLCipher's page-1 salt overwrites the bytes SQLite would
// otherwise auto-detect the page size from, so a connection that never
// reissues this pragma silently falls back to the compiled-in default.
const SET_PAGE_SIZE_SQL = `PRAGMA page_size = ${PAGE_SIZE}`;
const ENABLE_FOREIGN_KEYS_SQL = "PRAGMA foreign_keys = ON";

const CREATE_TXT_SQL = `
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
`;

const CREATE_TXT_BOOKMARKS_SQL = `
CREATE TABLE IF NOT EXISTS txt_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
  cfi TEXT NOT NULL,
  page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
  preview TEXT NOT NULL CHECK (length(CAST(preview AS BLOB)) <= 100),
  created_at INTEGER NOT NULL,
  UNIQUE (txt_id, cfi)
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

interface Executable {
  execSql(sql: string): void;
  query(sql: string): unknown[][];
  transaction<T>(operation: () => T): T;
}

export function ensureSchema(db: Executable): void {
  for (const stmt of [SET_PAGE_SIZE_SQL, ENABLE_FOREIGN_KEYS_SQL, CREATE_TXT_SQL]) {
    db.execSql(stmt);
  }
  db.transaction(() => ensureReadingSchema(db));
}

function ensureReadingSchema(db: Executable): void {
  const txtColumns = new Set(
    db.query("PRAGMA table_info(txt)").map((row) => row[1] as string),
  );
  if (!txtColumns.has("last_cfi")) {
    db.execSql("ALTER TABLE txt ADD COLUMN last_cfi TEXT");
  }

  const bookmarkExists = db.query(
    "SELECT 1 FROM sqlite_master " + "WHERE type = 'table' AND name = 'txt_bookmarks'",
  ).length;
  if (bookmarkExists) {
    const columns = new Set(
      db.query("PRAGMA table_info(txt_bookmarks)").map((row) => row[1] as string),
    );
    if (columns.has("line")) {
      const count = db.query("SELECT count(*) FROM txt_bookmarks")[0][0] as number;
      if (count > 0) {
        throw new Error(
          "legacy txt_bookmarks contains line bookmarks; " +
            "cannot migrate them safely to EPUB CFIs",
        );
      }
      db.execSql("DROP TRIGGER IF EXISTS trg_txt_bookmarks_cap");
      db.execSql("DROP INDEX IF EXISTS idx_txt_bookmarks_txt_id");
      db.execSql("DROP TABLE txt_bookmarks");
    } else if (!columns.has("cfi")) {
      throw new Error("txt_bookmarks has an unsupported schema");
    }
  }

  for (const statement of [
    CREATE_TXT_BOOKMARKS_SQL,
    CREATE_TXT_BOOKMARKS_INDEX_SQL,
    CREATE_TXT_BOOKMARKS_CAP_TRIGGER_SQL,
  ]) {
    db.execSql(statement);
  }
  const bookmarkColumns = new Set(
    db.query("PRAGMA table_info(txt_bookmarks)").map((row) => row[1] as string),
  );
  if (!bookmarkColumns.has("page_number")) {
    db.execSql(
      "ALTER TABLE txt_bookmarks ADD COLUMN page_number INTEGER " +
        "CHECK (page_number IS NULL OR page_number >= 1)",
    );
  }
}
