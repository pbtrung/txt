// Opens BB (docs/data_model.md §6.1/§7): a real, SQLCipher-keyed SQLite
// database backed by jsVfs.ts's in-memory VFS. Mirrors txt/bb_engine.py's
// BBEngine.open/query/execute/drain_dirty_pages -- execute/drainDirtyPages
// exist mainly so this module's own open round trip is testable the same
// way test_bb_engine.py tests the real thing (open, write, drain pages,
// reopen from just those pages); Step 10's read-position writes are the
// first real caller of the write side.
import { getSqlcipherModule } from "../crypto/sqlcipherLoader";
import type { SqlcipherWasmModule } from "../crypto/sqlcipherLoader";
import { registerJsVfs, type JsVfs } from "./jsVfs";
import { columnValue, cString, prepare, SQLITE_OK, type SqlRow, type SqlValue } from "./sqlite";

const PAGE_SIZE = 32768;
const DB_FILENAME = "/bb.db";
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_OPEN_READWRITE = 0x00000002;
const SQLITE_OPEN_CREATE = 0x00000004;

const PRAGMAS = [
  `PRAGMA page_size = ${PAGE_SIZE}`,
  "PRAGMA journal_mode = MEMORY",
  "PRAGMA synchronous = OFF",
  "PRAGMA auto_vacuum = NONE",
  "PRAGMA temp_store = MEMORY",
];

export interface BBEngine {
  query(sql: string, params?: SqlValue[]): SqlRow[];
  execute(sql: string, params?: SqlValue[]): void;
  drainDirtyPages(): Map<number, Uint8Array>;
  close(): void;
}

/** Populates the VFS's virtual /bb.db file from every live page's bytes --
 * a reassembled BB needs every one, not just page 1 (CLAUDE.md: SQLite's
 * own page-1 header records the total page count, so a partial set fails
 * with "database disk image is malformed", not a decrypt error). */
function loadPages(vfs: JsVfs, pages: Map<number, Uint8Array>): void {
  if (pages.size === 0) return;
  const maxPageNo = Math.max(...pages.keys());
  const buf = new Uint8Array(maxPageNo * PAGE_SIZE);
  for (const [pageNo, data] of pages) buf.set(data, (pageNo - 1) * PAGE_SIZE);
  vfs.files.set(DB_FILENAME, { bytes: buf });
}

function openHandle(mod: SqlcipherWasmModule): number {
  const ppDb = mod._malloc(4);
  const pathPtr = cString(mod, DB_FILENAME);
  const flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
  const rc = mod._sqlite3_open_v2(pathPtr, ppDb, flags, 0);
  const db = mod.getValue(ppDb, "i32");
  mod._free(ppDb);
  mod._free(pathPtr);
  if (rc !== SQLITE_OK) throw new Error(`sqlite3_open_v2 failed: rc=${rc}`);
  return db;
}

function keyDb(mod: SqlcipherWasmModule, db: number, dbMasterKey: Uint8Array): void {
  const hex = [...dbMasterKey].map((b) => b.toString(16).padStart(2, "0")).join("");
  const keyStr = `x'${hex}'`;
  const ptr = cString(mod, keyStr);
  const rc = mod._sqlite3_key(db, ptr, keyStr.length);
  mod._free(ptr);
  if (rc !== SQLITE_OK) throw new Error(`sqlite3_key failed: rc=${rc}`);
}

function execSql(mod: SqlcipherWasmModule, db: number, sql: string): void {
  const ptr = cString(mod, sql);
  const rc = mod._sqlite3_exec(db, ptr, 0, 0, 0);
  mod._free(ptr);
  if (rc !== SQLITE_OK) throw new Error(`"${sql}" failed: ${mod.UTF8ToString(mod._sqlite3_errmsg(db))}`);
}

function errmsg(mod: SqlcipherWasmModule, db: number): string {
  return mod.UTF8ToString(mod._sqlite3_errmsg(db));
}

function queryRows(mod: SqlcipherWasmModule, db: number, sql: string, params: SqlValue[]): SqlRow[] {
  const stmt = prepare(mod, db, sql, params);
  const rows: SqlRow[] = [];
  const colCount = mod._sqlite3_column_count(stmt);
  while (mod._sqlite3_step(stmt) === SQLITE_ROW) {
    rows.push(Array.from({ length: colCount }, (_, col) => columnValue(mod, stmt, col)));
  }
  mod._sqlite3_finalize(stmt);
  return rows;
}

function runStatement(mod: SqlcipherWasmModule, db: number, sql: string, params: SqlValue[]): void {
  const stmt = prepare(mod, db, sql, params);
  const rc = mod._sqlite3_step(stmt);
  mod._sqlite3_finalize(stmt);
  if (rc !== SQLITE_DONE) throw new Error(`"${sql}" step failed: rc=${rc}, ${errmsg(mod, db)}`);
}

let nextVfsId = 0;

/** Opens BB keyed with `dbMasterKey`, loaded with every page in `pages`.
 * Each call registers its own uniquely-named VFS: unlike txt/bb_engine.py
 * (one process, one BBEngine, exits after), this module's wasm instance
 * outlives any single Reader visit, so re-registering "jsvfs" on a second
 * open would be a second VFS under a name SQLite's own docs call
 * "undefined behavior" if it collides with one still in use. */
export async function openBB(dbMasterKey: Uint8Array, pages: Map<number, Uint8Array>): Promise<BBEngine> {
  const mod = await getSqlcipherModule();
  const dirtyPages = new Map<number, Uint8Array>();
  const onWrite = (name: string, offset: number, data: Uint8Array) => {
    if (name === DB_FILENAME) dirtyPages.set(Math.floor(offset / PAGE_SIZE) + 1, data);
  };
  const vfs = registerJsVfs(mod, `jsvfs-${nextVfsId++}`, true, onWrite);
  loadPages(vfs, pages);
  const db = openHandle(mod);
  keyDb(mod, db, dbMasterKey);
  for (const pragma of PRAGMAS) execSql(mod, db, pragma);
  return {
    query: (sql: string, params: SqlValue[] = []) => queryRows(mod, db, sql, params),
    execute: (sql: string, params: SqlValue[] = []) => runStatement(mod, db, sql, params),
    drainDirtyPages: () => {
      const drained = new Map(dirtyPages);
      dirtyPages.clear();
      return drained;
    },
    close: () => {
      mod._sqlite3_close(db);
    },
  };
}
