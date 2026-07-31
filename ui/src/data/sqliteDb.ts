// Browser port of txt/sqlite.ts's SqliteDb/Statement -- same raw
// SQLite/SQLCipher C API surface (see wasmLoader.ts's WasmModule), minus
// the Node-only bits that don't apply here: no flushToHost()/preload (this
// project's own on-disk file mirroring), since a browser session never
// reads from or writes to a real host filesystem -- its only two sources
// of database bytes are a fresh schema (never needed here; the server
// always seeds it) or pages fetched on demand through remoteVfs.ts.

import { type WasmModule, loadWasm, writeBuffer, readBuffer, cString } from "./wasmLoader";

const SQLITE_OK = 0;
const SQLITE_NULL = 5;
const SQLITE_OPEN_READONLY = 0x00000001;
const SQLITE_OPEN_READWRITE = 0x00000002;
const SQLITE_OPEN_CREATE = 0x00000004;
const SQLITE_TRANSIENT = -1;

export interface OpenOptions {
  vfsName?: string;
  rawKey?: Uint8Array;
  readOnly?: boolean;
}

export class SqliteDb {
  private readonly mod: WasmModule;
  private readonly db: number;

  private constructor(mod: WasmModule, db: number) {
    this.mod = mod;
    this.db = db;
  }

  static async open(path: string, opts: OpenOptions = {}): Promise<SqliteDb> {
    const mod = await loadWasm();
    const pathPtr = cString(mod, path);
    const vfsPtr = opts.vfsName ? cString(mod, opts.vfsName) : 0;
    const ppDb = mod._malloc(4);
    const flags = opts.readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
    const rc = mod._sqlite3_open_v2(pathPtr, ppDb, flags, vfsPtr);
    const db = mod.getValue(ppDb, "i32");
    mod._free(pathPtr);
    mod._free(ppDb);
    if (vfsPtr) mod._free(vfsPtr);
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_open_v2('${path}') failed: rc=${rc}`);
    const wrapper = new SqliteDb(mod, db);
    if (opts.rawKey) wrapper.key(opts.rawKey);
    return wrapper;
  }

  private key(rawKey: Uint8Array): void {
    const keyStr = `x'${Array.from(rawKey, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
    const ptr = cString(this.mod, keyStr);
    const rc = this.mod._sqlite3_key(this.db, ptr, this.mod.lengthBytesUTF8(keyStr));
    this.mod._free(ptr);
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_key failed: rc=${rc}`);
  }

  exec(sql: string): void {
    const ptr = cString(this.mod, sql);
    const rc = this.mod._sqlite3_exec(this.db, ptr, 0, 0, 0);
    this.mod._free(ptr);
    if (rc !== SQLITE_OK) throw new Error(`exec failed: ${this.errmsg()} (sql=${sql})`);
  }

  prepare(sql: string): Statement {
    const sqlPtr = cString(this.mod, sql);
    const ppStmt = this.mod._malloc(4);
    const rc = this.mod._sqlite3_prepare_v2(this.db, sqlPtr, -1, ppStmt, 0);
    const stmt = this.mod.getValue(ppStmt, "i32");
    this.mod._free(sqlPtr);
    this.mod._free(ppStmt);
    if (rc !== SQLITE_OK) throw new Error(`prepare failed: ${this.errmsg()} (sql=${sql})`);
    return new Statement(this.mod, stmt);
  }

  run(sql: string, bind?: (stmt: Statement) => void): void {
    const stmt = this.prepare(sql);
    bind?.(stmt);
    stmt.stepDone();
    stmt.finalize();
  }

  lastInsertRowId(): bigint {
    return this.mod._sqlite3_last_insert_rowid(this.db);
  }

  private errmsg(): string {
    const p = this.mod._sqlite3_errmsg(this.db);
    return p ? this.mod.UTF8ToString(p) : "";
  }

  close(): void {
    this.mod._sqlite3_close(this.db);
  }
}

export class Statement {
  private readonly mod: WasmModule;
  private readonly stmt: number;

  constructor(mod: WasmModule, stmt: number) {
    this.mod = mod;
    this.stmt = stmt;
  }

  bindBlob(i: number, data: Uint8Array): void {
    const ptr = writeBuffer(this.mod, data);
    this.mod._sqlite3_bind_blob(this.stmt, i, ptr, data.length, SQLITE_TRANSIENT);
    this.mod._free(ptr);
  }

  bindText(i: number, text: string): void {
    const ptr = cString(this.mod, text);
    this.mod._sqlite3_bind_text(
      this.stmt,
      i,
      ptr,
      this.mod.lengthBytesUTF8(text),
      SQLITE_TRANSIENT,
    );
    this.mod._free(ptr);
  }

  bindInt64(i: number, value: number | bigint): void {
    this.mod._sqlite3_bind_int64(this.stmt, i, BigInt(value));
  }

  bindNull(i: number): void {
    this.mod._sqlite3_bind_null(this.stmt, i);
  }

  step(): boolean {
    return this.mod._sqlite3_step(this.stmt) === 100; // SQLITE_ROW
  }

  stepDone(): void {
    this.mod._sqlite3_step(this.stmt);
  }

  columnIsNull(i: number): boolean {
    return this.mod._sqlite3_column_type(this.stmt, i) === SQLITE_NULL;
  }

  columnBlob(i: number): Uint8Array {
    const ptr = this.mod._sqlite3_column_blob(this.stmt, i);
    const len = this.mod._sqlite3_column_bytes(this.stmt, i);
    return readBuffer(this.mod, ptr, len);
  }

  columnText(i: number): string {
    return this.mod.UTF8ToString(this.mod._sqlite3_column_text(this.stmt, i));
  }

  columnInt64(i: number): bigint {
    return this.mod._sqlite3_column_int64(this.stmt, i);
  }

  finalize(): void {
    this.mod._sqlite3_finalize(this.stmt);
  }
}
