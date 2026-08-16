// Loads the prebuilt sqlcipher.wasm Emscripten build (sqlcipher/sqlcipher.js
// + .wasm -- the same module txt/leancrypto_wasm.py and txt/sqlite_engine.py
// host via wasmtime on the server side) in the browser.
//
// sqlcipher.js is a UMD/CJS bundle (`module.exports = Sqlite3Wasm`, no
// `export` keyword), so it can't be `import`-ed as a native ES module. It
// loads two different ways depending on environment:
//   - Browser: inject a classic (non-`type="module"`) <script> tag, then
//     read the resulting global `window.Sqlite3Wasm` factory.
//   - Node/Vitest: a plain dynamic `import()` works, because Node's ESM
//     loader interoperates with `module.exports` (sqlcipher/package.json
//     pins `"type": "commonjs"` so Node treats sqlcipher.js as CJS
//     regardless of this repo's own root "type": "module").
// In both cases the module's own asset-locating logic (Node's `__dirname`,
// the browser's `document.currentScript.src`) already resolves
// sqlcipher.wasm next to sqlcipher.js, so no `locateFile` override is
// needed.
import { isBrowser } from "../env";

// Baked in by vite.config.ts's `define` (a SHA-512 of sqlcipher/sqlcipher.js
// computed at build time).
declare const __SQLCIPHER_JS_INTEGRITY__: string;

export interface SqlcipherWasmModule {
  HEAPU8: Uint8Array;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  _malloc(size: number): number;
  _free(ptr: number): void;
  getValue(ptr: number, type: string): number;
  lengthBytesUTF8(str: string): number;
  stringToUTF8(str: string, outPtr: number, maxBytes: number): void;
  UTF8ToString(ptr: number): string;
  _sqlite3_open(filename: number, ppDb: number): number;
  _sqlite3_key(db: number, key: number, keyLen: number): number;
  _sqlite3_close(db: number): number;
  _sqlite3_errmsg(db: number): number;
  _sqlite3_exec(
    db: number,
    sql: number,
    callback: number,
    arg: number,
    errmsg: number,
  ): number;
  _sqlite3_prepare_v2(
    db: number,
    sql: number,
    nBytes: number,
    ppStmt: number,
    pzTail: number,
  ): number;
  _sqlite3_step(stmt: number): number;
  _sqlite3_finalize(stmt: number): number;
  _sqlite3_column_count(stmt: number): number;
  _sqlite3_column_type(stmt: number, col: number): number;
  _sqlite3_column_int64(stmt: number, col: number): bigint;
  _sqlite3_column_text(stmt: number, col: number): number;
  _sqlite3_column_bytes(stmt: number, col: number): number;
  _sqlite3_column_blob(stmt: number, col: number): number;
  _sqlite3_bind_int64(stmt: number, idx: number, value: bigint): number;
  _sqlite3_bind_blob(
    stmt: number,
    idx: number,
    ptr: number,
    len: number,
    destructor: number,
  ): number;
  _sqlite3_bind_text(
    stmt: number,
    idx: number,
    ptr: number,
    len: number,
    destructor: number,
  ): number;
  _sqlite3_bind_null(stmt: number, idx: number): number;
  _lc_wasm_key_size(): number;
  _lc_wasm_nonce_size(): number;
  _lc_wasm_tag_size(): number;
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

type SqlcipherFactory = (
  opts?: Record<string, unknown>,
) => Promise<SqlcipherWasmModule>;

function loadBrowserFactory(): Promise<SqlcipherFactory> {
  return new Promise((resolve, reject) => {
    const existing = (window as unknown as { Sqlite3Wasm?: SqlcipherFactory })
      .Sqlite3Wasm;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    // Set before src -- SRI is only enforced on the fetch the browser
    // triggers once this element is inserted into the document below;
    // integrity/crossOrigin need to already be present at that point.
    script.integrity = __SQLCIPHER_JS_INTEGRITY__;
    script.crossOrigin = "anonymous";
    script.src = "/sqlcipher.js";
    script.onload = () => {
      const factory = (window as unknown as { Sqlite3Wasm?: SqlcipherFactory })
        .Sqlite3Wasm;
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

async function loadNodeFactory(): Promise<SqlcipherFactory> {
  // This path only ever runs under Node/Vitest (see isBrowser(), used
  // below) -- @vite-ignore keeps Vite's client bundler from resolving/
  // inlining it into the browser build. Typed as `unknown` by
  // vite-env.d.ts's `declare module "*.js"` -- sqlcipher.js is untyped
  // vendored JS, not part of ui/'s own sources.
  const imported: unknown = await import(
    /* @vite-ignore */ "../../../sqlcipher/sqlcipher.js"
  );
  const mod = imported as { default?: SqlcipherFactory };
  const factory = mod.default ?? (imported as SqlcipherFactory);
  if (typeof factory !== "function") {
    throw new Error("sqlcipher.js did not provide a callable default export");
  }
  return factory;
}

let modulePromise: Promise<SqlcipherWasmModule> | null = null;

async function loadModule(): Promise<SqlcipherWasmModule> {
  const factory = isBrowser() ? await loadBrowserFactory() : await loadNodeFactory();
  return factory();
}

/** Resolves once sqlcipher.wasm is instantiated -- the module handle every
 * other crypto/data module needs. Cached: only ever instantiated once. */
export function getSqlcipherModule(): Promise<SqlcipherWasmModule> {
  if (!modulePromise) {
    modulePromise = loadModule();
  }
  return modulePromise;
}
