import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { SQLITE_OK } from "./constants.ts";

const require = createRequire(import.meta.url);

export interface Sqlite3Module {
  _malloc(size: number): number;
  _free(ptr: number): void;
  lengthBytesUTF8(str: string): number;
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  UTF8ToString(ptr: number): string;
  getValue(ptr: number, type: string): number;
  _sqlite3_open(filename: number, ppDb: number): number;
  _sqlite3_key(db: number, key: number, keyLen: number): number;
  _sqlite3_exec(db: number, sql: number, cb: number, arg: number, errmsg: number): number;
  _sqlite3_errmsg(db: number): number;
  _sqlite3_close(db: number): number;
  FS: { readFile(path: string): Uint8Array };
}

function cString(mod: Sqlite3Module, str: string): { ptr: number; len: number } {
  const len = mod.lengthBytesUTF8(str);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(str, ptr, len + 1);
  return { ptr, len };
}

export function hexKeyLiteral(rootKeyBase64: string): string {
  const hex = Buffer.from(rootKeyBase64, "base64").toString("hex");
  return `x'${hex}'`;
}

export class SqlCipherDb {
  private module: Sqlite3Module;
  private handle: number;
  private virtualPath: string;

  private constructor(module: Sqlite3Module, handle: number, virtualPath: string) {
    this.module = module;
    this.handle = handle;
    this.virtualPath = virtualPath;
  }

  static async open(virtualPath: string, hexKey: string): Promise<SqlCipherDb> {
    const factory = require("../sqlcipher/sqlcipher.js") as () => Promise<Sqlite3Module>;
    const module = await factory();
    const ppDb = module._malloc(4);
    const { ptr: fnPtr } = cString(module, virtualPath);
    const rc = module._sqlite3_open(fnPtr, ppDb);
    const handle = module.getValue(ppDb, "i32");
    module._free(ppDb);
    module._free(fnPtr);
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_open failed: rc=${rc}`);
    const db = new SqlCipherDb(module, handle, virtualPath);
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

  exportTo(hostPath: string): void {
    const bytes = this.module.FS.readFile(this.virtualPath);
    writeFileSync(hostPath, bytes);
  }

  close(): void {
    this.module._sqlite3_close(this.handle);
  }
}
