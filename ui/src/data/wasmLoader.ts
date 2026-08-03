// Loads the repo-root sqlcipher/sqlcipher.js WASM bundle (see CLAUDE.md) --
// covers both real SQLCipher access (sqliteDb.ts, remoteVfs.ts) and the
// lc_wasm_* HKDF/AEAD primitives crypto/blob.ts needs, in one module
// instance, replacing the old separately-vendored leancrypto.js entirely.
//
// Two loading paths (same module needs to load identically under Node/
// Vitest and in any web-like JS realm -- the main thread AND a Worker,
// since dbWorker.ts loads this same module inside a Worker, where SQLite/
// the lazy VFS actually have to live -- see dbWorker.ts's own header
// comment for why):
//   - Web (isWeb(), see ../env.ts): fetch() the real bytes, verify their
//     SHA-512 against __SQLCIPHER_JS_INTEGRITY__ ourselves (the same
//     guarantee a <script integrity=...> tag's native SRI would give on
//     the main thread, done manually here because a Worker has no
//     document/<script> tags at all to hang a tag-based SRI check off of),
//     then append `export default Sqlite3Wasm;` to the verified UMD source
//     (its own tail leaves `Sqlite3Wasm` as a plain top-level `var`, which
//     is exactly what makes this append valid -- see the bundle's own tail)
//     and import the result as a real ES module from a blob: URL. This
//     works identically on the main thread and inside a module Worker;
//     neither `<script>` tags nor `importScripts()` (classic-Worker-only,
//     and unavailable in the module Workers this project uses) do.
//   - Node/Vitest: a plain dynamic `import()` works, because Node's ESM
//     loader interoperates with `module.exports`.
// locateFile is passed explicitly to the web factory call (`{ locateFile:
// path => "/" + path }`) rather than relying on the bundle's own
// scriptDirectory detection (document.currentScript.src, import.meta.url,
// ...), which the blob: URL import makes unreliable -- `Module.locateFile`
// takes precedence over all of that when provided (confirmed by reading
// the bundle's own locateFile() function).

import { isWeb } from "../env";
import { bytesToBase64 } from "../crypto/bytes";

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
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
  // Stays loose rather than forcing a false (number | bigint) union onto
  // every callback's every parameter -- the real param types vary per
  // registered function, driven entirely by the runtime-only `signature`
  // string. The CLI's own equivalent (txt/lazyVfs.ts/r2Vfs.ts) sidesteps
  // this the same way, just less formally -- it types its own `mod` as
  // `any` throughout rather than declaring a shared WasmModule interface.
  addFunction(fn: (...args: any[]) => number, signature: string): number;
  removeFunction(ptr: number): void;

  _sqlite3_open_v2(
    filename: number,
    ppDb: number,
    flags: number,
    vfs: number,
  ): number;
  _sqlite3_close(db: number): number;
  _sqlite3_key(db: number, key: number, keyLen: number): number;
  _sqlite3_exec(
    db: number,
    sql: number,
    cb: number,
    cbArg: number,
    errmsg: number,
  ): number;
  _sqlite3_errmsg(db: number): number;
  _sqlite3_prepare_v2(
    db: number,
    sql: number,
    nByte: number,
    ppStmt: number,
    tail: number,
  ): number;
  _sqlite3_step(stmt: number): number;
  _sqlite3_finalize(stmt: number): number;
  _sqlite3_bind_blob(
    stmt: number,
    i: number,
    ptr: number,
    n: number,
    destructor: number,
  ): number;
  _sqlite3_bind_text(
    stmt: number,
    i: number,
    ptr: number,
    n: number,
    destructor: number,
  ): number;
  _sqlite3_bind_int64(stmt: number, i: number, value: bigint): number;
  _sqlite3_bind_null(stmt: number, i: number): number;
  _sqlite3_column_type(stmt: number, i: number): number;
  _sqlite3_column_blob(stmt: number, i: number): number;
  _sqlite3_column_bytes(stmt: number, i: number): number;
  _sqlite3_column_text(stmt: number, i: number): number;
  _sqlite3_column_int64(stmt: number, i: number): bigint;
  _sqlite3_last_insert_rowid(db: number): bigint;
  _sqlite3_changes(db: number): number;

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

/** Fetches /sqlcipher.js, verifies its SHA-512 against the build-time-baked
 * __SQLCIPHER_JS_INTEGRITY__, then imports it as a real ES module from a
 * blob: URL -- see this file's header comment for why (works identically on
 * the main thread and inside a module Worker, unlike a <script> tag or
 * importScripts()). */
async function loadWebFactory(): Promise<Sqlite3Factory> {
  const res = await fetch("/sqlcipher.js");
  if (!res.ok)
    throw new Error(`failed to fetch /sqlcipher.js: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-512", bytes);
  const actual = `sha512-${bytesToBase64(new Uint8Array(digest))}`;
  if (actual !== __SQLCIPHER_JS_INTEGRITY__) {
    throw new Error(
      "sqlcipher.js failed integrity check -- refusing to load it",
    );
  }

  const source = new TextDecoder().decode(bytes);
  // The bundle's own tail leaves `Sqlite3Wasm` as a plain top-level `var`
  // (see this file's header comment) -- appending an `export` referencing
  // it is what turns this into a real ES module the blob: URL below can be
  // `import()`-ed as, without needing eval()/`new Function` (which CSP's
  // script-src would otherwise have to allow via 'unsafe-eval').
  const blob = new Blob([source, "\nexport default Sqlite3Wasm;\n"], {
    type: "text/javascript",
  });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as {
      default?: Sqlite3Factory;
    };
    if (typeof mod.default !== "function") {
      throw new Error("sqlcipher.js did not provide a callable default export");
    }
    return mod.default;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function loadNodeFactory(): Promise<Sqlite3Factory> {
  // @vite-ignore: this path only ever runs under Node/Vitest (see isWeb(),
  // used below) -- keep Vite's client bundler from resolving/inlining it
  // into the browser build.
  const imported: unknown = await import(
    /* @vite-ignore */ "../../../sqlcipher/sqlcipher.js"
  );
  const mod = imported as { default?: Sqlite3Factory };
  const factory = mod.default ?? (imported as Sqlite3Factory);
  if (typeof factory !== "function") {
    throw new Error("sqlcipher.js did not provide a callable default export");
  }
  return factory;
}

let modulePromise: Promise<WasmModule> | null = null;

/** Resolves once the wasm module is instantiated -- memoized per realm (a
 * Worker has its own separate module instance/memoization from the main
 * thread, since each is its own JS realm), so every caller within one realm
 * (sqliteDb.ts opening a db, crypto/blob.ts encrypting/decrypting) shares
 * the same one instance for the life of that page/worker/test. */
export function loadWasm(): Promise<WasmModule> {
  if (!modulePromise) {
    modulePromise = (isWeb() ? loadWebFactory() : loadNodeFactory()).then(
      (factory) =>
        // locateFile: only needed on the web path -- the blob: URL import
        // that loadWebFactory() uses makes the bundle's own scriptDirectory
        // detection unreliable (see this file's header comment); Node's own
        // detection (__dirname-based) already works, so this only overrides
        // it there.
        isWeb()
          ? factory({ locateFile: (path: string) => `/${path}` })
          : factory(),
    );
  }
  return modulePromise;
}

export function writeBuffer(mod: WasmModule, data: Uint8Array): number {
  const ptr = mod._malloc(data.length || 1);
  mod.HEAPU8.set(data, ptr);
  return ptr;
}

export function readBuffer(
  mod: WasmModule,
  ptr: number,
  len: number,
): Uint8Array {
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
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  length: number,
): Promise<Uint8Array> {
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
