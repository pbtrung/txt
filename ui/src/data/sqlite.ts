// A minimal SQLite layer on top of sqlcipher.wasm, mirroring
// txt/sqlite_engine.py's SqliteEngine. Opens either a plain, unencrypted
// SQLite file (test fixtures) or a real SQLCipher database keyed with a
// raw 256-8192 byte key (docs/crypto.md's key provisioning range) -- the
// user's own db_master_key, in practice.
import { getSqlcipherModule } from "../crypto/sqlcipherLoader";
import type { SqlcipherWasmModule } from "../crypto/sqlcipherLoader";

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_INTEGER = 1;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_TRANSIENT = -1;

export type SqlValue = number | string | Uint8Array | null;
export type SqlRow = SqlValue[];

let nextPathId = 0;

function cString(mod: SqlcipherWasmModule, str: string): number {
  const len = mod.lengthBytesUTF8(str);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(str, ptr, len + 1);
  return ptr;
}

function columnValue(mod: SqlcipherWasmModule, stmt: number, col: number): SqlValue {
  const type = mod._sqlite3_column_type(stmt, col);
  if (type === SQLITE_INTEGER) return mod._sqlite3_column_int(stmt, col);
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
  if (value === null) {
    mod._sqlite3_bind_null(stmt, idx + 1);
  } else if (typeof value === "number") {
    // sqlite3_bind_int64's 3rd param is a real wasm i64 (WASM_BIGINT
    // semantics) -- it needs an actual BigInt, not a JS number.
    mod._sqlite3_bind_int64(stmt, idx + 1, BigInt(value));
  } else if (typeof value === "string") {
    const ptr = cString(mod, value);
    mod._sqlite3_bind_text(
      stmt,
      idx + 1,
      ptr,
      mod.lengthBytesUTF8(value),
      SQLITE_TRANSIENT,
    );
    mod._free(ptr);
  } else {
    const ptr = mod._malloc(value.length || 1);
    mod.HEAPU8.set(value, ptr);
    mod._sqlite3_bind_blob(stmt, idx + 1, ptr, value.length, SQLITE_TRANSIENT);
    mod._free(ptr);
  }
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
  params.forEach((value, idx) => bindParam(mod, stmt, idx, value));
  return stmt;
}

function readRows(mod: SqlcipherWasmModule, stmt: number): SqlRow[] {
  const rows: SqlRow[] = [];
  const colCount = mod._sqlite3_column_count(stmt);
  while (mod._sqlite3_step(stmt) === SQLITE_ROW) {
    rows.push(
      Array.from({ length: colCount }, (_, col) => columnValue(mod, stmt, col)),
    );
  }
  mod._sqlite3_finalize(stmt);
  return rows;
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
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_open failed: rc=${rc}`);
    if (key) keyDatabase(mod, db, key);
    return new SqliteDatabase(mod, db, path);
  }

  /** Opens a plain, unencrypted SQLite file; omit `bytes` to create a fresh one. */
  static openUnkeyed(bytes?: Uint8Array): Promise<SqliteDatabase> {
    return SqliteDatabase.openHandle(bytes ?? null, null);
  }

  /** Opens a SQLCipher database keyed with a raw 256-8192 byte key. `bytes`
   * is omitted to create a fresh database instead of opening an existing
   * one (docs/data_model.md §2 step 2). */
  static openKeyed(key: Uint8Array, bytes?: Uint8Array): Promise<SqliteDatabase> {
    return SqliteDatabase.openHandle(bytes ?? null, key);
  }

  query(sql: string, params: SqlValue[] = []): SqlRow[] {
    return readRows(this.mod, prepare(this.mod, this.db, sql, params));
  }

  /** Runs (possibly multi-statement, unparameterized) SQL -- schema DDL. */
  execSql(sql: string): void {
    const ptr = cString(this.mod, sql);
    const rc = this.mod._sqlite3_exec(this.db, ptr, 0, 0, 0);
    this.mod._free(ptr);
    if (rc !== SQLITE_OK) {
      const message = this.mod.UTF8ToString(this.mod._sqlite3_errmsg(this.db));
      throw new Error(`"${sql}" failed: ${message}`);
    }
  }

  /** The database file's current on-disk bytes (post-close, callers should
   * read this before close() -- MEMFS discards the path on unlink). */
  toBytes(): Uint8Array {
    return this.mod.FS.readFile(this.path);
  }

  close(): void {
    this.mod._sqlite3_close(this.db);
    this.mod.FS.unlink(this.path);
  }
}
