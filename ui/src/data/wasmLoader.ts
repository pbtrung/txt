// Loads the repo-root sqlcipher/sqlcipher.js WASM bundle (see CLAUDE.md) --
// covers both real SQLCipher access (sqliteDb.ts, remoteVfs.ts) and the
// lc_wasm_* HKDF/AEAD primitives crypto/blob.ts needs, in one module
// instance, replacing the old separately-vendored leancrypto.js entirely.
//
// Two loading paths, same split as the old crypto/leancryptoLoader.ts (the
// same module needs to load identically in a real browser and under
// Node/Vitest):
//   - Browser: inject a classic (non-`type="module"`) <script src="/sqlcipher.js">
//     tag -- the bundle is a UMD build (`module.exports=Sqlite3Wasm` when
//     `module`/`exports` exist, else left as the top-level `var Sqlite3Wasm`,
//     confirmed by inspecting the bundle's own tail) so it can't be
//     `import`-ed as a native ES module here -- then read the resulting
//     global `window.Sqlite3Wasm` factory.
//   - Node/Vitest: a plain dynamic `import()` works, because Node's ESM
//     loader interoperates with `module.exports`.
// In both cases the module's own asset-locating logic (Node's `__dirname`,
// the browser's `document.currentScript.src`) already resolves
// sqlcipher.wasm correctly next to sqlcipher.js, so no `locateFile`
// override is needed.

import { isBrowser } from "../env";

// Baked in by vite.config.ts's `define` (a SHA-512 of sqlcipher/sqlcipher.js
// computed at build time) -- see loadBrowserFactory()'s use of it below.
declare const __SQLCIPHER_JS_INTEGRITY__: string;

export interface WasmModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, maxBytes: number): number;
  UTF8ToString(ptr: number): string;
  getValue(ptr: number, type: string): number;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
  FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array };
  // See txt/wasm.ts's identical declaration for why this stays loose rather
  // than forcing a false (number | bigint) union onto every callback's
  // every parameter -- the real param types vary per registered function,
  // driven entirely by the runtime-only `signature` string.
  addFunction(fn: (...args: any[]) => number, signature: string): number;
  removeFunction(ptr: number): void;

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

type Sqlite3Factory = (opts?: Record<string, unknown>) => Promise<WasmModule>;

function loadBrowserFactory(): Promise<Sqlite3Factory> {
  return new Promise((resolve, reject) => {
    const existing = (window as unknown as { Sqlite3Wasm?: Sqlite3Factory }).Sqlite3Wasm;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    // Set before src -- SRI is only enforced on the fetch the browser
    // triggers once this element is inserted into the document below;
    // integrity/crossOrigin need to already be present at that point, not
    // added afterward.
    script.integrity = __SQLCIPHER_JS_INTEGRITY__;
    script.crossOrigin = "anonymous";
    script.src = "/sqlcipher.js";
    script.onload = () => {
      const factory = (window as unknown as { Sqlite3Wasm?: Sqlite3Factory }).Sqlite3Wasm;
      if (!factory) {
        reject(new Error("sqlcipher.js loaded but did not define window.Sqlite3Wasm"));
        return;
      }
      resolve(factory);
    };
    script.onerror = () => reject(new Error("failed to load /sqlcipher.js"));
    document.head.appendChild(script);
  });
}

async function loadNodeFactory(): Promise<Sqlite3Factory> {
  // @vite-ignore: this path only ever runs under Node/Vitest (see
  // isBrowser(), used below) -- keep Vite's client bundler from resolving/
  // inlining it into the browser build.
  const imported: unknown = await import(/* @vite-ignore */ "../../../sqlcipher/sqlcipher.js");
  const mod = imported as { default?: Sqlite3Factory };
  const factory = mod.default ?? (imported as Sqlite3Factory);
  if (typeof factory !== "function") {
    throw new Error("sqlcipher.js did not provide a callable default export");
  }
  return factory;
}

let modulePromise: Promise<WasmModule> | null = null;

/** Resolves once the wasm module is instantiated -- memoized, so every
 * caller (sqliteDb.ts opening a db, crypto/blob.ts encrypting/decrypting)
 * shares the same one instance for the life of the page/test. */
export function loadWasm(): Promise<WasmModule> {
  if (!modulePromise) {
    modulePromise = (isBrowser() ? loadBrowserFactory() : loadNodeFactory()).then((factory) =>
      factory(),
    );
  }
  return modulePromise;
}

export function writeBuffer(mod: WasmModule, data: Uint8Array): number {
  const ptr = mod._malloc(data.length || 1);
  mod.HEAPU8.set(data, ptr);
  return ptr;
}

export function readBuffer(mod: WasmModule, ptr: number, len: number): Uint8Array {
  return mod.HEAPU8.slice(ptr, ptr + len);
}

export function cString(mod: WasmModule, s: string): number {
  const len = mod.lengthBytesUTF8(s);
  const ptr = mod._malloc(len + 1);
  mod.stringToUTF8(s, ptr, len + 1);
  return ptr;
}

class LeanCryptoError extends Error {
  constructor(what: string, ret: number) {
    super(`${what} failed: ${ret}`);
    this.name = "LeanCryptoError";
  }
}

function check(ret: number, what: string): void {
  if (ret !== 0) throw new LeanCryptoError(what, ret);
}

/** HKDF-SHA3-512(ikm, salt) -> length bytes of OKM. Same primitive/sizes as
 * txt/blobCipher.ts's own hkdf, just exposed with crypto/blob.ts's existing
 * (ikm, salt, length) signature so it's a drop-in replacement for the old
 * leancryptoLoader.ts's hkdf(). */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, length: number): Promise<Uint8Array> {
  const mod = await loadWasm();
  const ikmPtr = writeBuffer(mod, ikm);
  const saltPtr = writeBuffer(mod, salt);
  const outPtr = mod._malloc(length || 1);
  try {
    const ret = mod._lc_wasm_hkdf_sha3_512(
      ikmPtr,
      ikm.length,
      saltPtr,
      salt.length,
      0,
      0,
      outPtr,
      length,
    );
    check(ret, "lc_wasm_hkdf_sha3_512");
    return readBuffer(mod, outPtr, length);
  } finally {
    mod._free(ikmPtr);
    mod._free(saltPtr);
    mod._free(outPtr);
  }
}

export interface AeadResult {
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

/** AEAD encrypt (Ascon-Keccak, keyed by HKDF-derived key/iv -- see crypto/blob.ts). */
export async function aeadEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  tagLen: number,
): Promise<AeadResult> {
  const mod = await loadWasm();
  const ptrs = [key, iv, aad, plaintext].map((b) => writeBuffer(mod, b));
  const ctPtr = mod._malloc(plaintext.length || 1);
  const tagPtr = mod._malloc(tagLen);
  try {
    const ret = mod._lc_wasm_aead_encrypt(
      ptrs[0]!,
      key.length,
      ptrs[1]!,
      iv.length,
      ptrs[2]!,
      aad.length,
      ptrs[3]!,
      plaintext.length,
      ctPtr,
      tagPtr,
      tagLen,
    );
    check(ret, "lc_wasm_aead_encrypt");
    return {
      ciphertext: readBuffer(mod, ctPtr, plaintext.length),
      tag: readBuffer(mod, tagPtr, tagLen),
    };
  } finally {
    for (const p of ptrs) mod._free(p);
    mod._free(ctPtr);
    mod._free(tagPtr);
  }
}

/** AEAD decrypt; throws LeanCryptoError if tag verification fails. */
export async function aeadDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Promise<Uint8Array> {
  const mod = await loadWasm();
  const ptrs = [key, iv, aad, ciphertext, tag].map((b) => writeBuffer(mod, b));
  const ptPtr = mod._malloc(ciphertext.length || 1);
  try {
    const ret = mod._lc_wasm_aead_decrypt(
      ptrs[0]!,
      key.length,
      ptrs[1]!,
      iv.length,
      ptrs[2]!,
      aad.length,
      ptrs[3]!,
      ciphertext.length,
      ptPtr,
      ptrs[4]!,
      tag.length,
    );
    check(ret, "lc_wasm_aead_decrypt (auth failure)");
    return readBuffer(mod, ptPtr, ciphertext.length);
  } finally {
    for (const p of ptrs) mod._free(p);
    mod._free(ptPtr);
  }
}
