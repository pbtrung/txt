// Builds a fresh per-user SQLCipher database (docs/data_model.md's "Per-user
// SQLCipher database schema") entirely in the vendored WASM module's virtual
// filesystem, then reads back its raw (already page-encrypted) bytes for
// paging into R2 -- via the raw SQLite C API (sqlite3_open/key/exec/close),
// not the leancrypto AEAD/HKDF wrapper CryptoEngine uses.
// @ts-ignore -- no type declarations beyond `declare function Sqlite3Wasm(): Promise<any>`
import Sqlite3Wasm from "../sqlcipher/sqlcipher.js";

const SQLITE_OK = 0;

// docs/data_model.md's "Per-user SQLCipher database schema" -- keep in sync.
const SCHEMA_SQL = `
PRAGMA page_size = 32768;
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE txt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
    content     BLOB    NOT NULL UNIQUE,
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

function cString(mod: any, str: string): { ptr: number; len: number } {
  const len = mod.lengthBytesUTF8(str);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(str, ptr, len + 1);
  return { ptr, len };
}

function hexKey(keyBytes: Buffer): string {
  return `x'${keyBytes.toString("hex")}'`;
}

export class SqlCipherBuilder {
  private module: any;

  private constructor(module: any) {
    this.module = module;
  }

  static async create(): Promise<SqlCipherBuilder> {
    return new SqlCipherBuilder(await Sqlite3Wasm());
  }

  // Returns the new database's raw bytes -- already page-encrypted under
  // dbKey by SQLCipher itself, ready to be split into R2 page uploads.
  buildInitialDatabase(dbKey: Buffer): Buffer {
    const path = `/init-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    this.unlinkIfExists(path);
    const db = this.openAndKey(path, dbKey);
    try {
      this.exec(db, SCHEMA_SQL);
      return this.readFile(path);
    } finally {
      this.module._sqlite3_close(db);
      this.unlinkIfExists(path);
    }
  }

  private unlinkIfExists(path: string): void {
    try {
      this.module.FS.unlink(path);
    } catch {
      // no-op: didn't exist yet
    }
  }

  private openAndKey(path: string, dbKey: Buffer): number {
    const ppDb = this.module._malloc(4);
    const { ptr: pathPtr } = cString(this.module, path);
    try {
      const rc = this.module._sqlite3_open(pathPtr, ppDb);
      const db = this.module.getValue(ppDb, "i32");
      if (rc !== SQLITE_OK) throw new Error(`sqlite3_open failed, rc=${rc}`);
      this.keyDatabase(db, dbKey);
      return db;
    } finally {
      this.module._free(ppDb);
      this.module._free(pathPtr);
    }
  }

  private keyDatabase(db: number, dbKey: Buffer): void {
    const { ptr: keyPtr, len: keyLen } = cString(this.module, hexKey(dbKey));
    try {
      const rc = this.module._sqlite3_key(db, keyPtr, keyLen);
      if (rc !== SQLITE_OK) throw new Error(`sqlite3_key failed, rc=${rc}`);
    } finally {
      this.module._free(keyPtr);
    }
  }

  private exec(db: number, sql: string): void {
    const { ptr } = cString(this.module, sql);
    try {
      const rc = this.module._sqlite3_exec(db, ptr, 0, 0, 0);
      if (rc !== SQLITE_OK)
        throw new Error(`sqlite3_exec failed: ${this.errmsg(db)}`);
    } finally {
      this.module._free(ptr);
    }
  }

  private errmsg(db: number): string {
    const p = this.module._sqlite3_errmsg(db);
    return p ? this.module.UTF8ToString(p) : "(no error message)";
  }

  private readFile(path: string): Buffer {
    return Buffer.from(this.module.FS.readFile(path));
  }
}
