import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SQLITE_DONE, SQLITE_OK, SQLITE_ROW, VIRTUAL_DB_PATH } from "./constants.ts";

const require = createRequire(import.meta.url);

export interface Sqlite3Module {
  _malloc(size: number): number;
  _free(ptr: number): void;
  lengthBytesUTF8(str: string): number;
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  UTF8ToString(ptr: number): string;
  getValue(ptr: number, type: string): number;
  HEAPU8: Uint8Array;
  _sqlite3_open(filename: number, ppDb: number): number;
  _sqlite3_key(db: number, key: number, keyLen: number): number;
  _sqlite3_exec(db: number, sql: number, cb: number, arg: number, errmsg: number): number;
  _sqlite3_errmsg(db: number): number;
  _sqlite3_close(db: number): number;
  _sqlite3_prepare_v2(db: number, sql: number, nByte: number, ppStmt: number, tail: number): number;
  _sqlite3_bind_int(stmt: number, index: number, value: number): number;
  _sqlite3_bind_blob(stmt: number, index: number, ptr: number, len: number, destructor: number): number;
  _sqlite3_step(stmt: number): number;
  _sqlite3_finalize(stmt: number): number;
  _sqlite3_column_blob(stmt: number, col: number): number;
  _sqlite3_column_bytes(stmt: number, col: number): number;
  _sqlite3_last_insert_rowid(db: number): bigint;
  FS: { readFile(path: string): Uint8Array; writeFile(path: string, data: Uint8Array): void };
}

const SQLITE_TRANSIENT = -1;

function cString(mod: Sqlite3Module, str: string): { ptr: number; len: number } {
  const len = mod.lengthBytesUTF8(str);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(str, ptr, len + 1);
  return { ptr, len };
}

export function hexKeyLiteral(masterKeyBase64: string): string {
  const hex = Buffer.from(masterKeyBase64, "base64").toString("hex");
  return `x'${hex}'`;
}

export class SqlCipherDb {
  private module: Sqlite3Module;
  private handle: number;
  private hostPath: string;

  private constructor(module: Sqlite3Module, handle: number, hostPath: string) {
    this.module = module;
    this.handle = handle;
    this.hostPath = hostPath;
  }

  static async open(hostPath: string, hexKey: string): Promise<SqlCipherDb> {
    const factory = require("../sqlcipher/sqlcipher.js") as () => Promise<Sqlite3Module>;
    const module = await factory();
    if (existsSync(hostPath)) module.FS.writeFile(VIRTUAL_DB_PATH, readFileSync(hostPath));
    const ppDb = module._malloc(4);
    const { ptr: fnPtr } = cString(module, VIRTUAL_DB_PATH);
    const rc = module._sqlite3_open(fnPtr, ppDb);
    const handle = module.getValue(ppDb, "i32");
    module._free(ppDb);
    module._free(fnPtr);
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_open failed: rc=${rc}`);
    const db = new SqlCipherDb(module, handle, hostPath);
    db.key(hexKey);
    return db;
  }

  private key(hexKey: string): void {
    const { ptr, len } = cString(this.module, hexKey);
    const rc = this.module._sqlite3_key(this.handle, ptr, len);
    this.module._free(ptr);
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_key failed: rc=${rc}`);
  }

  exec(sql: string): void {
    const { ptr } = cString(this.module, sql);
    const rc = this.module._sqlite3_exec(this.handle, ptr, 0, 0, 0);
    this.module._free(ptr);
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_exec failed: ${this.errmsg()}`);
  }

  private errmsg(): string {
    const ptr = this.module._sqlite3_errmsg(this.handle);
    return ptr ? this.module.UTF8ToString(ptr) : "";
  }

  private prepare(sql: string): number {
    const ppStmt = this.module._malloc(4);
    const { ptr } = cString(this.module, sql);
    const rc = this.module._sqlite3_prepare_v2(this.handle, ptr, -1, ppStmt, 0);
    const stmt = this.module.getValue(ppStmt, "i32");
    this.module._free(ppStmt);
    this.module._free(ptr);
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_prepare_v2 failed: ${this.errmsg()}`);
    return stmt;
  }

  private bindBlob(stmt: number, index: number, data: Uint8Array): void {
    const ptr = this.module._malloc(data.length || 1);
    this.module.HEAPU8.set(data, ptr);
    this.module._sqlite3_bind_blob(stmt, index, ptr, data.length, SQLITE_TRANSIENT);
    this.module._free(ptr);
  }

  private stepDone(stmt: number): void {
    const rc = this.module._sqlite3_step(stmt);
    const err = rc !== SQLITE_DONE ? this.errmsg() : "";
    this.module._sqlite3_finalize(stmt);
    if (rc !== SQLITE_DONE) throw new Error(`sqlite3_step failed: ${err}`);
  }

  private readBlobColumn(stmt: number, col: number): Uint8Array {
    const ptr = this.module._sqlite3_column_blob(stmt, col);
    const len = this.module._sqlite3_column_bytes(stmt, col);
    return this.module.HEAPU8.slice(ptr, ptr + len);
  }

  insertTxt(): number {
    this.exec("INSERT INTO txt DEFAULT VALUES;");
    return Number(this.module._sqlite3_last_insert_rowid(this.handle));
  }

  insertPart(txtId: number, partNum: number, content: Uint8Array): void {
    const stmt = this.prepare("INSERT INTO txt_parts (txt_id, part_num, content) VALUES (?, ?, ?);");
    this.module._sqlite3_bind_int(stmt, 1, txtId);
    this.module._sqlite3_bind_int(stmt, 2, partNum);
    this.bindBlob(stmt, 3, content);
    this.stepDone(stmt);
  }

  getMetadataBlob(): Uint8Array | null {
    const stmt = this.prepare("SELECT content FROM txt_metadata WHERE id = 1;");
    const rc = this.module._sqlite3_step(stmt);
    const result = rc === SQLITE_ROW ? this.readBlobColumn(stmt, 0) : null;
    this.module._sqlite3_finalize(stmt);
    return result;
  }

  setMetadataBlob(data: Uint8Array): void {
    const stmt = this.prepare(
      "INSERT INTO txt_metadata (id, content) VALUES (1, ?) " +
        "ON CONFLICT(id) DO UPDATE SET content = excluded.content;"
    );
    this.bindBlob(stmt, 1, data);
    this.stepDone(stmt);
  }

  save(): void {
    const bytes = this.module.FS.readFile(VIRTUAL_DB_PATH);
    writeFileSync(this.hostPath, bytes);
  }

  close(): void {
    this.module._sqlite3_close(this.handle);
  }
}
