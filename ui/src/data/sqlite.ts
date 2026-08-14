// A minimal SQLite layer on top of sqlcipher.wasm. Used unkeyed for the
// library index (SQLCipher IS SQLite, and a database never given a key via
// sqlite3_key() just opens as a plain SQLite file -- no separate sql.js
// dependency needed) and, with a key, as the primitives bbEngine.ts builds
// BB's own open/query/execute on top of. Ported from
// sqlcipher/test-roundtrip.mjs's own cString/openDb/collectRows helpers,
// generalized to arbitrary result columns and bound parameters.
import { getSqlcipherModule } from "../crypto/sqlcipherLoader";
import type { SqlcipherWasmModule } from "../crypto/sqlcipherLoader";

export const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_INTEGER = 1;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_TRANSIENT = -1;

export type SqlValue = number | string | Uint8Array | null;
export type SqlRow = SqlValue[];

let nextPathId = 0;

export function cString(mod: SqlcipherWasmModule, str: string): number {
  const len = mod.lengthBytesUTF8(str);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(str, ptr, len + 1);
  return ptr;
}

function openHandle(mod: SqlcipherWasmModule, path: string): number {
  const ppDb = mod._malloc(4);
  const pathPtr = cString(mod, path);
  const rc = mod._sqlite3_open(pathPtr, ppDb);
  const db = mod.getValue(ppDb, "i32");
  mod._free(ppDb);
  mod._free(pathPtr);
  if (rc !== SQLITE_OK) throw new Error(`sqlite3_open failed: rc=${rc}`);
  return db;
}

export function columnValue(mod: SqlcipherWasmModule, stmt: number, col: number): SqlValue {
  const type = mod._sqlite3_column_type(stmt, col);
  if (type === SQLITE_INTEGER) return mod._sqlite3_column_int(stmt, col);
  if (type === SQLITE_TEXT) return mod.UTF8ToString(mod._sqlite3_column_text(stmt, col));
  if (type === SQLITE_BLOB) {
    const len = mod._sqlite3_column_bytes(stmt, col);
    const ptr = mod._sqlite3_column_blob(stmt, col);
    return mod.HEAPU8.slice(ptr, ptr + len);
  }
  return null;
}

export function bindParam(mod: SqlcipherWasmModule, stmt: number, idx: number, value: SqlValue): void {
  if (value === null) {
    mod._sqlite3_bind_null(stmt, idx + 1);
  } else if (typeof value === "number") {
    // sqlite3_bind_int64's 3rd param is a real wasm i64 (this build uses
    // WASM_BIGINT semantics) -- it needs an actual BigInt, not a JS number.
    mod._sqlite3_bind_int64(stmt, idx + 1, BigInt(value));
  } else if (typeof value === "string") {
    const ptr = cString(mod, value);
    mod._sqlite3_bind_text(stmt, idx + 1, ptr, mod.lengthBytesUTF8(value), SQLITE_TRANSIENT);
    mod._free(ptr);
  } else {
    const ptr = mod._malloc(value.length || 1);
    mod.HEAPU8.set(value, ptr);
    mod._sqlite3_bind_blob(stmt, idx + 1, ptr, value.length, SQLITE_TRANSIENT);
    mod._free(ptr);
  }
}

/** Prepares `sql`, binds `params` (1-indexed placeholders, 0-indexed here),
 * and leaves the statement ready for the caller to step/finalize. */
export function prepare(mod: SqlcipherWasmModule, db: number, sql: string, params: SqlValue[]): number {
  const ppStmt = mod._malloc(4);
  const sqlPtr = cString(mod, sql);
  const rc = mod._sqlite3_prepare_v2(db, sqlPtr, -1, ppStmt, 0);
  mod._free(sqlPtr);
  if (rc !== SQLITE_OK) {
    mod._free(ppStmt);
    throw new Error(`prepare "${sql}" failed: ${mod.UTF8ToString(mod._sqlite3_errmsg(db))}`);
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
    rows.push(Array.from({ length: colCount }, (_, col) => columnValue(mod, stmt, col)));
  }
  mod._sqlite3_finalize(stmt);
  return rows;
}

function query(mod: SqlcipherWasmModule, db: number, sql: string, params: SqlValue[]): SqlRow[] {
  return readRows(mod, prepare(mod, db, sql, params));
}

export interface SqliteDb {
  query(sql: string, params?: SqlValue[]): SqlRow[];
  close(): void;
}

/** Opens an unkeyed, in-memory SQLite database from raw file bytes (an
 * Emscripten MEMFS-backed path under the hood -- no real filesystem). */
export async function openSqliteFromBytes(bytes: Uint8Array): Promise<SqliteDb> {
  const mod = await getSqlcipherModule();
  const path = `/library-index-${nextPathId++}.sqlite`;
  mod.FS.writeFile(path, bytes);
  const db = openHandle(mod, path);
  return {
    query: (sql: string, params: SqlValue[] = []) => query(mod, db, sql, params),
    close: () => {
      mod._sqlite3_close(db);
      mod.FS.unlink(path);
    },
  };
}
