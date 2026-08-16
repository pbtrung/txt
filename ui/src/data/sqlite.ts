// A minimal SQLite layer on top of sqlcipher.wasm, mirroring
// txt/sqlite_engine.py's SqliteEngine. Opens either a plain, unencrypted
// SQLite file (test fixtures) or a real SQLCipher database keyed with a
// raw 256-8192 byte key (docs/crypto.md's key provisioning range) -- the
// user's own db_master_key, in practice.
import { getSqlcipherModule } from "../crypto/sqlcipherLoader";
import type { SqlcipherWasmModule } from "../crypto/sqlcipherLoader";

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_INTEGER = 1;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_TRANSIENT = -1;

type SqlValue = number | string | Uint8Array | null;
type SqlRow = SqlValue[];

let nextPathId = 0;

function cString(mod: SqlcipherWasmModule, str: string): number {
  const len = mod.lengthBytesUTF8(str);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(str, ptr, len + 1);
  return ptr;
}

function checkResult(
  mod: SqlcipherWasmModule,
  db: number,
  result: number,
  operation: string,
): void {
  if (result === SQLITE_OK) return;
  const message = db
    ? mod.UTF8ToString(mod._sqlite3_errmsg(db))
    : "unknown SQLite error";
  throw new Error(`${operation} failed: ${message} (rc=${result})`);
}

function columnValue(mod: SqlcipherWasmModule, stmt: number, col: number): SqlValue {
  const type = mod._sqlite3_column_type(stmt, col);
  if (type === SQLITE_INTEGER) {
    const value = Number(mod._sqlite3_column_int64(stmt, col));
    if (!Number.isSafeInteger(value)) {
      throw new Error("SQLite integer exceeds JavaScript's safe range");
    }
    return value;
  }
  if (type === SQLITE_TEXT)
    return mod.UTF8ToString(mod._sqlite3_column_text(stmt, col));
  if (type === SQLITE_BLOB) {
    const len = mod._sqlite3_column_bytes(stmt, col);
    const ptr = mod._sqlite3_column_blob(stmt, col);
    return mod.HEAPU8.slice(ptr, ptr + len);
  }
  return null;
}

function bindParam(
  mod: SqlcipherWasmModule,
  stmt: number,
  idx: number,
  value: SqlValue,
): void {
  let result: number;
  if (value === null) {
    result = mod._sqlite3_bind_null(stmt, idx + 1);
  } else if (typeof value === "number") {
    // sqlite3_bind_int64's 3rd param is a real wasm i64 (WASM_BIGINT
    // semantics) -- it needs an actual BigInt, not a JS number.
    if (!Number.isSafeInteger(value)) {
      throw new Error(`bind parameter ${idx + 1} must be a safe integer`);
    }
    result = mod._sqlite3_bind_int64(stmt, idx + 1, BigInt(value));
  } else if (typeof value === "string") {
    const ptr = cString(mod, value);
    try {
      result = mod._sqlite3_bind_text(
        stmt,
        idx + 1,
        ptr,
        mod.lengthBytesUTF8(value),
        SQLITE_TRANSIENT,
      );
    } finally {
      mod._free(ptr);
    }
  } else {
    const ptr = mod._malloc(value.length || 1);
    try {
      mod.HEAPU8.set(value, ptr);
      result = mod._sqlite3_bind_blob(
        stmt,
        idx + 1,
        ptr,
        value.length,
        SQLITE_TRANSIENT,
      );
    } finally {
      mod._free(ptr);
    }
  }
  if (result !== SQLITE_OK) throw new Error(`bind parameter ${idx + 1} failed`);
}

function prepare(
  mod: SqlcipherWasmModule,
  db: number,
  sql: string,
  params: SqlValue[],
): number {
  const ppStmt = mod._malloc(4);
  const sqlPtr = cString(mod, sql);
  const rc = mod._sqlite3_prepare_v2(db, sqlPtr, -1, ppStmt, 0);
  mod._free(sqlPtr);
  if (rc !== SQLITE_OK) {
    mod._free(ppStmt);
    throw new Error(
      `prepare "${sql}" failed: ${mod.UTF8ToString(mod._sqlite3_errmsg(db))}`,
    );
  }
  const stmt = mod.getValue(ppStmt, "i32");
  mod._free(ppStmt);
  try {
    params.forEach((value, idx) => bindParam(mod, stmt, idx, value));
  } catch (error) {
    mod._sqlite3_finalize(stmt);
    throw error;
  }
  return stmt;
}

function readRows(mod: SqlcipherWasmModule, db: number, stmt: number): SqlRow[] {
  const rows: SqlRow[] = [];
  const colCount = mod._sqlite3_column_count(stmt);
  try {
    while (true) {
      const result = mod._sqlite3_step(stmt);
      if (result === SQLITE_DONE) return rows;
      if (result !== SQLITE_ROW) {
        checkResult(mod, db, result, "sqlite3_step");
      }
      rows.push(
        Array.from({ length: colCount }, (_, col) => columnValue(mod, stmt, col)),
      );
    }
  } finally {
    mod._sqlite3_finalize(stmt);
  }
}

function keyDatabase(mod: SqlcipherWasmModule, db: number, key: Uint8Array): void {
  const keyHex = [...key].map((b) => b.toString(16).padStart(2, "0")).join("");
  const keyStr = `x'${keyHex}'`;
  const ptr = cString(mod, keyStr);
  const rc = mod._sqlite3_key(db, ptr, mod.lengthBytesUTF8(keyStr));
  mod._free(ptr);
  if (rc !== SQLITE_OK) throw new Error(`sqlite3_key failed: rc=${rc}`);
}

export class SqliteDatabase {
  private closed = false;

  private constructor(
    private readonly mod: SqlcipherWasmModule,
    private readonly db: number,
    private readonly path: string,
  ) {}

  private static async openHandle(
    bytes: Uint8Array | null,
    key: Uint8Array | null,
  ): Promise<SqliteDatabase> {
    const mod = await getSqlcipherModule();
    const path = `/db-${nextPathId++}.sqlite`;
    if (bytes) mod.FS.writeFile(path, bytes);
    const ppDb = mod._malloc(4);
    const pathPtr = cString(mod, path);
    const rc = mod._sqlite3_open(pathPtr, ppDb);
    const db = mod.getValue(ppDb, "i32");
    mod._free(ppDb);
    mod._free(pathPtr);
    try {
      checkResult(mod, db, rc, "sqlite3_open");
      if (key) keyDatabase(mod, db, key);
      return new SqliteDatabase(mod, db, path);
    } catch (error) {
      if (db) mod._sqlite3_close(db);
      try {
        mod.FS.unlink(path);
      } catch {
        // sqlite3_open can fail before creating the backing file.
      }
      throw error;
    }
  }

  /** Opens a plain, unencrypted SQLite file; omit `bytes` to create a fresh one. */
  static openUnkeyed(bytes?: Uint8Array): Promise<SqliteDatabase> {
    return SqliteDatabase.openHandle(bytes ?? null, null);
  }

  /** Opens a SQLCipher database keyed with a raw 256-8192 byte key. `bytes`
   * is omitted to create a fresh database instead of opening an existing
   * one (docs/data_model.md §2 step 2). */
  static async openKeyed(key: Uint8Array, bytes?: Uint8Array): Promise<SqliteDatabase> {
    if (key.length < 256 || key.length > 8192) {
      throw new Error("SQLCipher key must be between 256 and 8192 bytes");
    }
    return SqliteDatabase.openHandle(bytes ?? null, key);
  }

  query(sql: string, params: SqlValue[] = []): SqlRow[] {
    this.assertOpen();
    return readRows(this.mod, this.db, prepare(this.mod, this.db, sql, params));
  }

  /** Runs (possibly multi-statement, unparameterized) SQL -- schema DDL. */
  execSql(sql: string): void {
    this.assertOpen();
    const ptr = cString(this.mod, sql);
    try {
      const rc = this.mod._sqlite3_exec(this.db, ptr, 0, 0, 0);
      checkResult(this.mod, this.db, rc, `execute "${sql}"`);
    } finally {
      this.mod._free(ptr);
    }
  }

  /** The database file's current bytes. Call before close(), which unlinks it. */
  toBytes(): Uint8Array {
    this.assertOpen();
    return this.mod.FS.readFile(this.path);
  }

  close(): void {
    if (this.closed) return;
    const rc = this.mod._sqlite3_close(this.db);
    checkResult(this.mod, this.db, rc, "sqlite3_close");
    this.mod.FS.unlink(this.path);
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("database is closed");
  }
}
