// Typed surface of sqlcipher/sqlcipher.js -- an Emscripten module exporting
// the raw SQLite/SQLCipher C API plus leancrypto's lc_wasm_* AEAD/HKDF
// wrappers and a JS-backed sqlite3_vfs bridge (see sqlcipher/js-vfs.mjs).
// Only the members this project actually calls are declared.

export interface WasmModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, maxBytes: number): number;
  UTF8ToString(ptr: number): string;
  getValue(ptr: number, type: string): number;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  // The callback's real param types vary per registered function, driven
  // entirely by the runtime-only `signature` string (e.g. 'iiiij' means a
  // 64-bit bigint 4th arg under this build's WASM_BIGINT) -- there's no way
  // for a single static type to capture that, so callers keep their own
  // functions concretely typed (number vs. bigint per param) and this
  // declaration stays deliberately loose rather than forcing a false
  // (number | bigint) union onto every parameter of every callback.
  addFunction(fn: (...args: any[]) => number, signature: string): number;
  removeFunction(ptr: number): void;
  FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array };
  HEAPF64: Float64Array;

  /** See sqlcipher/js-vfs.mjs -- wires a JS-implemented sqlite3_vfs into the real C struct. */
  _sqlite3_js_vfs_register(
    zName: number,
    szOsFile: number,
    mxPathname: number,
    makeDefault: number,
    methods: number,
  ): number;
  /** Address of the one shared sqlite3_io_methods struct js-vfs.mjs-style VFSes install. */
  _sqlite3_js_vfs_io_methods(): number;

  _sqlite3_open(filename: number, ppDb: number): number;
  _sqlite3_open_v2(filename: number, ppDb: number, flags: number, vfs: number): number;
  _sqlite3_close(db: number): number;
  _sqlite3_key(db: number, key: number, keyLen: number): number;
  _sqlite3_exec(db: number, sql: number, cb: number, cbArg: number, errmsg: number): number;
  _sqlite3_errmsg(db: number): number;
  _sqlite3_prepare_v2(db: number, sql: number, nByte: number, ppStmt: number, tail: number): number;
  _sqlite3_step(stmt: number): number;
  _sqlite3_finalize(stmt: number): number;
  _sqlite3_bind_blob(stmt: number, i: number, ptr: number, n: number, destructor: number): number;
  _sqlite3_bind_text(stmt: number, i: number, ptr: number, n: number, destructor: number): number;
  _sqlite3_bind_int64(stmt: number, i: number, value: bigint): number;
  _sqlite3_bind_null(stmt: number, i: number): number;
  _sqlite3_column_type(stmt: number, i: number): number;
  _sqlite3_column_blob(stmt: number, i: number): number;
  _sqlite3_column_bytes(stmt: number, i: number): number;
  _sqlite3_column_text(stmt: number, i: number): number;
  _sqlite3_column_int64(stmt: number, i: number): bigint;
  _sqlite3_last_insert_rowid(db: number): bigint;

  _lc_wasm_hkdf_sha3_512(
    ikm: number,
    ikmLen: number,
    salt: number,
    saltLen: number,
    info: number,
    infoLen: number,
    out: number,
    outLen: number,
  ): number;
  _lc_wasm_aead_encrypt(
    key: number,
    keySz: number,
    nonce: number,
    nonceSz: number,
    aad: number,
    aadLen: number,
    pt: number,
    ptLen: number,
    ct: number,
    tag: number,
    tagSz: number,
  ): number;
  _lc_wasm_aead_decrypt(
    key: number,
    keySz: number,
    nonce: number,
    nonceSz: number,
    aad: number,
    aadLen: number,
    ct: number,
    ctLen: number,
    pt: number,
    tag: number,
    tagSz: number,
  ): number;
}

let modulePromise: Promise<WasmModule> | undefined;

export function loadWasm(): Promise<WasmModule> {
  if (!modulePromise) {
    modulePromise = import("../sqlcipher/sqlcipher.js").then((m) => m.default());
  }
  return modulePromise;
}

export function writeBuffer(mod: WasmModule, data: Uint8Array): number {
  const ptr = mod._malloc(data.length || 1);
  mod.HEAPU8.set(data, ptr);
  return ptr;
}

export function readBuffer(mod: WasmModule, ptr: number, len: number): Buffer {
  return Buffer.from(mod.HEAPU8.subarray(ptr, ptr + len));
}

export function cString(mod: WasmModule, s: string): number {
  const len = mod.lengthBytesUTF8(s);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(s, ptr, len + 1);
  return ptr;
}
