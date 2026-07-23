// Loads the prebuilt leancrypto Emscripten build (ui/leancrypto/leancrypto.js
// + .wasm) and exposes the handful of C functions txt/crypto.py binds via
// ctypes (see txt/leancrypto.py): AEAD, HKDF, HMAC, PBKDF2, and the
// lc_kyber_1024_x448 composite KEM.
//
// Two non-obvious things this file has to get right (see docs/ui.md's
// implementation plan for how these were found):
//
// 1. leancrypto.js is a UMD/CJS bundle (`module.exports = leancrypto`, no
//    `export` keyword) so it can't be `import`-ed as a native ES module in
//    the browser. It loads two different ways depending on environment:
//      - Browser: inject a classic (non-`type="module"`) <script> tag, then
//        read the resulting global `window.leancrypto` factory.
//      - Node/Vitest: a plain dynamic `import()` works, because Node's ESM
//        loader interoperates with `module.exports`.
//    In both cases the module's own default asset-locating logic (Node's
//    `__dirname`, the browser's `document.currentScript.src`) already
//    resolves leancrypto.wasm correctly next to leancrypto.js, so no
//    `locateFile` override is needed.
//
// 2. `lc_sha3_512`, `lc_sha3_256`, and `lc_seeded_rng` are C `extern
//    <type> *name;` globals (pointers, not structs -- see
//    /usr/include/leancrypto/lc_sha3.h, lc_rng.h). This wasm build exposes
//    them as PIC-style GOT globals: `Module._lc_sha3_512` is the *address of
//    the pointer variable*, not the pointer's value. One more dereference
//    (`HEAPU32[addr / 4]`) is required before passing the result as the
//    "hash type" argument to lc_hkdf/lc_hmac/lc_pbkdf2/lc_ak_alloc_taglen (or
//    lc_seeded_rng before lc_kyber_1024_x448_keypair) -- skipping it crashes
//    with "RuntimeError: table index is out of bounds".

import { isBrowser } from "../env";

export interface LeancryptoModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;

  _lc_sha3_512: number;
  _lc_sha3_256: number;
  _lc_seeded_rng: number;

  _lc_hkdf(
    hash: number,
    ikm: number,
    ikmLen: number,
    salt: number,
    saltLen: number,
    info: number,
    infoLen: number,
    out: number,
    outLen: number,
  ): number;
  _lc_hmac(hash: number, key: number, keyLen: number, data: number, dataLen: number, out: number): number;
  _lc_pbkdf2(
    hash: number,
    password: number,
    passwordLen: number,
    salt: number,
    saltLen: number,
    iterations: number,
    out: number,
    outLen: number,
  ): number;

  _lc_ak_alloc_taglen(hash: number, tagLen: number, ctxOut: number): number;
  _lc_aead_setkey(ctx: number, key: number, keyLen: number, iv: number, ivLen: number): number;
  _lc_aead_encrypt(
    ctx: number,
    pt: number,
    ct: number,
    ptLen: number,
    aad: number,
    aadLen: number,
    tag: number,
    tagLen: number,
  ): number;
  _lc_aead_decrypt(
    ctx: number,
    ct: number,
    pt: number,
    ctLen: number,
    aad: number,
    aadLen: number,
    tag: number,
    tagLen: number,
  ): number;
  _lc_aead_zero_free(ctx: number): void;

  _lc_kyber_1024_x448_keypair(pk: number, sk: number, rng: number): number;
  _lc_kyber_1024_x448_enc(ct: number, ss: number, pk: number): number;
  _lc_kyber_1024_x448_dec(ss: number, ct: number, sk: number): number;
}

type LeancryptoFactory = (opts?: Record<string, unknown>) => Promise<LeancryptoModule>;

function loadBrowserFactory(): Promise<LeancryptoFactory> {
  return new Promise((resolve, reject) => {
    const existing = (window as unknown as { leancrypto?: LeancryptoFactory }).leancrypto;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = "/leancrypto.js";
    script.onload = () => {
      const factory = (window as unknown as { leancrypto?: LeancryptoFactory }).leancrypto;
      if (!factory) {
        reject(new Error("leancrypto.js loaded but did not define window.leancrypto"));
        return;
      }
      resolve(factory);
    };
    script.onerror = () => reject(new Error("failed to load /leancrypto.js"));
    document.head.appendChild(script);
  });
}

async function loadNodeFactory(): Promise<LeancryptoFactory> {
  // @vite-ignore: this path only ever runs under Node/Vitest (see
  // isBrowser(), used below) -- keep Vite's client bundler from resolving/
  // inlining it into the browser build.
  const imported: unknown = await import(/* @vite-ignore */ "../../leancrypto/leancrypto.js");
  const mod = imported as { default?: LeancryptoFactory };
  const factory = mod.default ?? (imported as LeancryptoFactory);
  if (typeof factory !== "function") {
    throw new Error("leancrypto.js did not provide a callable default export");
  }
  return factory;
}

let modulePromise: Promise<LeancryptoModule> | null = null;

async function loadModule(): Promise<LeancryptoModule> {
  const factory = isBrowser() ? await loadBrowserFactory() : await loadNodeFactory();
  return factory();
}

function getModule(): Promise<LeancryptoModule> {
  if (!modulePromise) {
    modulePromise = loadModule();
  }
  return modulePromise;
}

/** Dereferences a GOT-style exported global to the pointer value it holds. */
function deref(mod: LeancryptoModule, gotAddr: number): number {
  return mod.HEAPU32[gotAddr / 4];
}

export interface LeancryptoHandle {
  mod: LeancryptoModule;
  sha3_512: number;
  sha3_256: number;
  seededRng: number;
}

let handlePromise: Promise<LeancryptoHandle> | null = null;

/** Resolves once the wasm module is instantiated and its hash-type/RNG
 * pointers are dereferenced -- the handle every other crypto module needs. */
export function getLeancrypto(): Promise<LeancryptoHandle> {
  if (!handlePromise) {
    handlePromise = getModule().then((mod) => ({
      mod,
      sha3_512: deref(mod, mod._lc_sha3_512),
      sha3_256: deref(mod, mod._lc_sha3_256),
      seededRng: deref(mod, mod._lc_seeded_rng),
    }));
  }
  return handlePromise;
}

function writeBytes(mod: LeancryptoModule, bytes: Uint8Array): number {
  const ptr = mod._malloc(bytes.length || 1);
  mod.HEAPU8.set(bytes, ptr);
  return ptr;
}

function readBytes(mod: LeancryptoModule, ptr: number, len: number): Uint8Array {
  return mod.HEAPU8.slice(ptr, ptr + len);
}

class LeanCryptoError extends Error {
  constructor(what: string, ret: number) {
    super(`${what} failed: ${ret}`);
    this.name = "LeanCryptoError";
  }
}

function check(ret: number, what: string): void {
  if (ret !== 0) {
    throw new LeanCryptoError(what, ret);
  }
}

/** HKDF-SHA3-512(ikm, salt) -> length bytes of OKM. */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, length: number): Promise<Uint8Array> {
  const { mod, sha3_512 } = await getLeancrypto();
  const ikmPtr = writeBytes(mod, ikm);
  const saltPtr = writeBytes(mod, salt);
  const outPtr = mod._malloc(length || 1);
  try {
    const ret = mod._lc_hkdf(sha3_512, ikmPtr, ikm.length, saltPtr, salt.length, 0, 0, outPtr, length);
    check(ret, "lc_hkdf");
    return readBytes(mod, outPtr, length);
  } finally {
    mod._free(ikmPtr);
    mod._free(saltPtr);
    mod._free(outPtr);
  }
}

/** HMAC-SHA3-256(key, data), used for username_hash. */
export async function hmacSha3_256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const { mod, sha3_256 } = await getLeancrypto();
  const OUT_LEN = 32;
  const keyPtr = writeBytes(mod, key);
  const dataPtr = writeBytes(mod, data);
  const outPtr = mod._malloc(OUT_LEN);
  try {
    const ret = mod._lc_hmac(sha3_256, keyPtr, key.length, dataPtr, data.length, outPtr);
    check(ret, "lc_hmac");
    return readBytes(mod, outPtr, OUT_LEN);
  } finally {
    mod._free(keyPtr);
    mod._free(dataPtr);
    mod._free(outPtr);
  }
}

/** PBKDF2-HMAC-SHA3-256(password, salt, iterations) -> keyLen bytes, used for pw_hash. */
export async function pbkdf2Sha3_256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLen: number,
): Promise<Uint8Array> {
  const { mod, sha3_256 } = await getLeancrypto();
  const pwPtr = writeBytes(mod, password);
  const saltPtr = writeBytes(mod, salt);
  const outPtr = mod._malloc(keyLen || 1);
  try {
    const ret = mod._lc_pbkdf2(sha3_256, pwPtr, password.length, saltPtr, salt.length, iterations, outPtr, keyLen);
    check(ret, "lc_pbkdf2");
    return readBytes(mod, outPtr, keyLen);
  } finally {
    mod._free(pwPtr);
    mod._free(saltPtr);
    mod._free(outPtr);
  }
}

export interface AeadResult {
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

/** Ascon-Keccak AEAD encrypt, keyed by HKDF-derived key/iv (see crypto.ts's Blob). */
export async function aeadEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  tagLen: number,
): Promise<AeadResult> {
  const { mod, sha3_512 } = await getLeancrypto();
  const ctxPtrPtr = mod._malloc(4);
  const keyPtr = writeBytes(mod, key);
  const ivPtr = writeBytes(mod, iv);
  const aadPtr = writeBytes(mod, aad);
  const ptPtr = writeBytes(mod, plaintext);
  const ctPtr = mod._malloc(plaintext.length || 1);
  const tagPtr = mod._malloc(tagLen);
  let ctx = 0;
  try {
    check(mod._lc_ak_alloc_taglen(sha3_512, tagLen, ctxPtrPtr), "lc_ak_alloc_taglen");
    ctx = mod.HEAPU32[ctxPtrPtr / 4];
    check(mod._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length), "lc_aead_setkey");
    check(
      mod._lc_aead_encrypt(ctx, ptPtr, ctPtr, plaintext.length, aadPtr, aad.length, tagPtr, tagLen),
      "lc_aead_encrypt",
    );
    return {
      ciphertext: readBytes(mod, ctPtr, plaintext.length),
      tag: readBytes(mod, tagPtr, tagLen),
    };
  } finally {
    if (ctx) mod._lc_aead_zero_free(ctx);
    mod._free(ctxPtrPtr);
    mod._free(keyPtr);
    mod._free(ivPtr);
    mod._free(aadPtr);
    mod._free(ptPtr);
    mod._free(ctPtr);
    mod._free(tagPtr);
  }
}

/** Ascon-Keccak AEAD decrypt; throws LeanCryptoError if tag verification fails. */
export async function aeadDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Promise<Uint8Array> {
  const { mod, sha3_512 } = await getLeancrypto();
  const ctxPtrPtr = mod._malloc(4);
  const keyPtr = writeBytes(mod, key);
  const ivPtr = writeBytes(mod, iv);
  const aadPtr = writeBytes(mod, aad);
  const ctPtr = writeBytes(mod, ciphertext);
  const tagPtr = writeBytes(mod, tag);
  const ptPtr = mod._malloc(ciphertext.length || 1);
  let ctx = 0;
  try {
    check(mod._lc_ak_alloc_taglen(sha3_512, tag.length, ctxPtrPtr), "lc_ak_alloc_taglen");
    ctx = mod.HEAPU32[ctxPtrPtr / 4];
    check(mod._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length), "lc_aead_setkey");
    check(
      mod._lc_aead_decrypt(ctx, ctPtr, ptPtr, ciphertext.length, aadPtr, aad.length, tagPtr, tag.length),
      "lc_aead_decrypt",
    );
    return readBytes(mod, ptPtr, ciphertext.length);
  } finally {
    if (ctx) mod._lc_aead_zero_free(ctx);
    mod._free(ctxPtrPtr);
    mod._free(keyPtr);
    mod._free(ivPtr);
    mod._free(aadPtr);
    mod._free(ctPtr);
    mod._free(tagPtr);
    mod._free(ptPtr);
  }
}

export interface KemKeypair {
  pk: Uint8Array;
  sk: Uint8Array;
}

export async function kemKeypair(pkLen: number, skLen: number): Promise<KemKeypair> {
  const { mod, seededRng } = await getLeancrypto();
  const pkPtr = mod._malloc(pkLen);
  const skPtr = mod._malloc(skLen);
  try {
    check(mod._lc_kyber_1024_x448_keypair(pkPtr, skPtr, seededRng), "lc_kyber_1024_x448_keypair");
    return { pk: readBytes(mod, pkPtr, pkLen), sk: readBytes(mod, skPtr, skLen) };
  } finally {
    mod._free(pkPtr);
    mod._free(skPtr);
  }
}

export interface KemEncapsulation {
  ct: Uint8Array;
  ss: Uint8Array;
}

export async function kemEncapsulate(pk: Uint8Array, ctLen: number, ssLen: number): Promise<KemEncapsulation> {
  const { mod } = await getLeancrypto();
  const pkPtr = writeBytes(mod, pk);
  const ctPtr = mod._malloc(ctLen);
  const ssPtr = mod._malloc(ssLen);
  try {
    check(mod._lc_kyber_1024_x448_enc(ctPtr, ssPtr, pkPtr), "lc_kyber_1024_x448_enc");
    return { ct: readBytes(mod, ctPtr, ctLen), ss: readBytes(mod, ssPtr, ssLen) };
  } finally {
    mod._free(pkPtr);
    mod._free(ctPtr);
    mod._free(ssPtr);
  }
}

export async function kemDecapsulate(sk: Uint8Array, ct: Uint8Array, ssLen: number): Promise<Uint8Array> {
  const { mod } = await getLeancrypto();
  const skPtr = writeBytes(mod, sk);
  const ctPtr = writeBytes(mod, ct);
  const ssPtr = mod._malloc(ssLen);
  try {
    check(mod._lc_kyber_1024_x448_dec(ssPtr, ctPtr, skPtr), "lc_kyber_1024_x448_dec");
    return readBytes(mod, ssPtr, ssLen);
  } finally {
    mod._free(skPtr);
    mod._free(ctPtr);
    mod._free(ssPtr);
  }
}
