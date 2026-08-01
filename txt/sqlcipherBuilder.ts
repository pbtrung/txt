// Runs SQL against a SQLCipher database via the raw SQLite C API
// (sqlite3_open_v2/key/exec/close), against whichever VFS the caller
// registered (see r2Vfs.ts) -- not the leancrypto AEAD/HKDF wrapper
// CryptoEngine uses. Exposes its WASM module instance so a caller can
// register an R2Vfs against the exact same module before opening.
// @ts-ignore -- no type declarations beyond `declare function Sqlite3Wasm(): Promise<any>`
import Sqlite3Wasm from "../sqlcipher/sqlcipher.js";
import { SQLCIPHER_PAGE_SIZE } from "./constants.ts";

const SQLITE_OK = 0;
const SQLITE_OPEN_READWRITE = 0x00000002;
const SQLITE_OPEN_CREATE = 0x00000004;

// docs/data_model.md's "Per-user SQLCipher database schema" -- keep in sync.
// cipher_default_page_size isn't part of this block: run() always sets it
// before keying (see openAndKey), on both create and reopen.
export const SCHEMA_SQL = `
PRAGMA page_size = ${SQLCIPHER_PAGE_SIZE};
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
  readonly module: any;

  private constructor(module: any) {
    this.module = module;
  }

  static async create(): Promise<SqlCipherBuilder> {
    return new SqlCipherBuilder(await Sqlite3Wasm());
  }

  // Opens (creating if needed) dbFileName against the named VFS, keys it,
  // runs sql, and closes it -- the VFS's own backing store (see r2Vfs.ts)
  // is where the resulting bytes actually live.
  run(dbFileName: string, vfsName: string, dbKey: Buffer, sql: string): void {
    const db = this.openAndKey(dbFileName, vfsName, dbKey);
    try {
      this.exec(db, sql);
    } finally {
      this.module._sqlite3_close(db);
    }
  }

  private openAndKey(
    dbFileName: string,
    vfsName: string,
    dbKey: Buffer,
  ): number {
    const ppDb = this.module._malloc(4);
    const { ptr: pathPtr } = cString(this.module, dbFileName);
    const { ptr: vfsPtr } = cString(this.module, vfsName);
    try {
      const flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
      const rc = this.module._sqlite3_open_v2(pathPtr, ppDb, flags, vfsPtr);
      const db = this.module.getValue(ppDb, "i32");
      if (rc !== SQLITE_OK) throw new Error(`sqlite3_open_v2 failed, rc=${rc}`);
      this.setCipherPageSize(db);
      this.keyDatabase(db, dbKey);
      return db;
    } finally {
      this.module._free(ppDb);
      this.module._free(pathPtr);
      this.module._free(vfsPtr);
    }
  }

  // Must run before sqlite3_key -- this codec has no plaintext header to
  // sniff the real page size from on reopen (confirmed empirically: without
  // this, reopening a non-default-page-size database fails to decrypt page 1
  // at all, "unrecognized magic/version bytes"). Harmless to also run this
  // on a brand-new database, since it matches what PRAGMA page_size then
  // establishes on disk.
  private setCipherPageSize(db: number): void {
    this.exec(db, `PRAGMA cipher_default_page_size = ${SQLCIPHER_PAGE_SIZE};`);
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
}
