// Builds a temporary per-user SQLCipher database entirely through the
// JS-backed sqlite3_vfs (sqlcipher/js-vfs.mjs), then hands back its raw
// bytes so the caller can chop them into pages for the rqlite page store.
// See docs/data_model.md's "User SQLCipher Database" for this schema.

import { registerJsVfs } from "../sqlcipher/js-vfs.mjs";
import { loadWasm } from "./wasm.ts";
import { SqliteDb } from "./sqlite.ts";

const PAGE_SIZE = 4096;
const PATH = "/user.db";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE txt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_key       BLOB    NOT NULL,
    name          TEXT    NOT NULL,
    metadata      BLOB,
    last_part_num INTEGER,
    last_accessed INTEGER,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (id, last_part_num) REFERENCES txt_parts(txt_id, part_num)
);

CREATE INDEX idx_txt_last_accessed ON txt(last_accessed DESC);

CREATE TABLE txt_parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id   INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num INTEGER NOT NULL,
    path     TEXT    NOT NULL UNIQUE,
    UNIQUE (txt_id, part_num)
);

CREATE TABLE txt_bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    txt_id     INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
    part_num   INTEGER NOT NULL,
    line       INTEGER NOT NULL,
    preview    TEXT    NOT NULL CHECK (length(preview) <= 60),
    created_at INTEGER NOT NULL,
    UNIQUE (txt_id, part_num, line)
);

CREATE INDEX idx_txt_bookmarks_txt_id_created_at ON txt_bookmarks(txt_id, created_at);

CREATE TRIGGER trg_txt_bookmarks_cap
AFTER INSERT ON txt_bookmarks
BEGIN
  DELETE FROM txt_bookmarks
  WHERE txt_id = NEW.txt_id
    AND id NOT IN (
      SELECT id FROM txt_bookmarks
      WHERE txt_id = NEW.txt_id
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    );
END;
`;

export interface FinishedUserDb {
  bytes: Uint8Array;
  pageSize: number;
  pageCount: number;
}

export class UserDb {
  private readonly db: SqliteDb;
  private readonly files: Map<string, { bytes: Uint8Array }>;

  private constructor(db: SqliteDb, files: Map<string, { bytes: Uint8Array }>) {
    this.db = db;
    this.files = files;
  }

  static async create(rawKey: Uint8Array): Promise<UserDb> {
    const mod = await loadWasm();
    const { name, files } = registerJsVfs(mod, { name: "userdb-vfs" });
    const db = await SqliteDb.open(PATH, { vfsName: name, rawKey });
    db.exec(`PRAGMA page_size = ${PAGE_SIZE};`);
    db.exec(SCHEMA);
    return new UserDb(db, files);
  }

  /** Reopens a previously snapshotted database (schema already applied) to continue a run. */
  static async resume(rawKey: Uint8Array, bytes: Uint8Array): Promise<UserDb> {
    const mod = await loadWasm();
    const { name, files } = registerJsVfs(mod, { name: "userdb-vfs" });
    files.set(PATH, { bytes: new Uint8Array(bytes) });
    const db = await SqliteDb.open(PATH, { vfsName: name, rawKey });
    return new UserDb(db, files);
  }

  insertTxt(
    txtKey: Uint8Array,
    name: string,
    metadata: Buffer | null,
    createdAtMs: number,
  ): bigint {
    this.db.run(
      "INSERT INTO txt (txt_key, name, metadata, created_at) VALUES (?, ?, ?, ?);",
      (s) => {
        s.bindBlob(1, txtKey);
        s.bindText(2, name);
        metadata ? s.bindBlob(3, metadata) : s.bindNull(3);
        s.bindInt64(4, createdAtMs);
      },
    );
    return this.db.lastInsertRowId();
  }

  insertPart(txtId: bigint, partNum: bigint, path: string): void {
    this.db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (?, ?, ?);", (s) => {
      s.bindInt64(1, txtId);
      s.bindInt64(2, partNum);
      s.bindText(3, path);
    });
  }

  hasPart(txtId: bigint, partNum: bigint): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM txt_parts WHERE txt_id = ? AND part_num = ?;");
    stmt.bindInt64(1, txtId);
    stmt.bindInt64(2, partNum);
    const found = stmt.step();
    stmt.finalize();
    return found;
  }

  /** Current bytes without closing the database -- safe to call after each autocommit statement. */
  snapshot(): FinishedUserDb {
    const entry = this.files.get(PATH);
    if (!entry) throw new Error("temp user db missing from VFS store");
    return { bytes: entry.bytes, pageSize: PAGE_SIZE, pageCount: entry.bytes.length / PAGE_SIZE };
  }

  finish(): FinishedUserDb {
    const result = this.snapshot();
    this.db.close();
    return result;
  }

  /**
   * How many documents are already durably committed, in the same id-ascending
   * order oldVault.listTxt() migrates them in -- the resume marker. Since a
   * document is only ever committed to rqlite_txt.db once all of its parts are
   * done (see MigrateCommand), this count is always exactly "documents fully
   * migrated so far", never a partially-migrated one.
   */
  countTxt(): number {
    const stmt = this.db.prepare("SELECT count(*) FROM txt;");
    stmt.step();
    const count = Number(stmt.columnInt64(0));
    stmt.finalize();
    return count;
  }
}
