// A minimal SQLite reader on top of sqlcipher.wasm, used unkeyed: SQLCipher
// IS SQLite, and a database never given a key via sqlite3_key() just opens
// as a plain SQLite file. The library index is exactly that (its outer
// CryptoBlob wrapper is the only encryption it has -- docs/data_model.md
// §8.1), so no separate sql.js dependency is needed to read it. Ported from
// sqlcipher/test-roundtrip.mjs's own cString/openDb/collectRows helpers,
// generalized to arbitrary result columns instead of fixed int/text pairs.
import { getSqlcipherModule } from "../crypto/sqlcipherLoader";
import type { SqlcipherWasmModule } from "../crypto/sqlcipherLoader";

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_INTEGER = 1;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;

export type SqlValue = number | string | Uint8Array | null;
export type SqlRow = SqlValue[];

let nextPathId = 0;

function cString(mod: SqlcipherWasmModule, str: string): number {
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

function columnValue(mod: SqlcipherWasmModule, stmt: number, col: number): SqlValue {
  const type = mod._sqlite3_column_type(stmt, col);
  if (type === SQLITE_INTEGER) return mod._sqlite3_column_int(stmt, col);
  if (type === SQLITE_TEXT) return mod.UTF8ToString(mod._sqlite3_column_text(stmt, col));
  if (type === SQLITE_BLOB) {
    const len = mod._sqlite3_column_bytes(stmt, col);
    return mod.HEAPU8.slice(mod._sqlite3_column_blob(stmt, col), mod._sqlite3_column_blob(stmt, col) + len);
  }
  return null;
}

function collectRows(mod: SqlcipherWasmModule, db: number, sql: string): SqlRow[] {
  const ppStmt = mod._malloc(4);
  const sqlPtr = cString(mod, sql);
  const rc = mod._sqlite3_prepare_v2(db, sqlPtr, -1, ppStmt, 0);
  mod._free(sqlPtr);
  if (rc !== SQLITE_OK) {
    mod._free(ppStmt);
    throw new Error(`sqlite3_prepare_v2 failed: ${mod.UTF8ToString(mod._sqlite3_errmsg(db))}`);
  }
  const stmt = mod.getValue(ppStmt, "i32");
  mod._free(ppStmt);
  return readRows(mod, stmt);
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

export interface SqliteDb {
  query(sql: string): SqlRow[];
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
    query: (sql: string) => collectRows(mod, db, sql),
    close: () => {
      mod._sqlite3_close(db);
      mod.FS.unlink(path);
    },
  };
}
