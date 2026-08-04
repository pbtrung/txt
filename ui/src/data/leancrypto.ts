// Loads the repo-root leancrypto/leancrypto.js WASM bundle (see CLAUDE.md,
// shared with txt/crypto.ts, whose alloc/setkey/run/free AEAD lifecycle and
// GOT-global-dereference trick this file mirrors) -- exposes the HKDF-SHA3-512
// and Ascon-Keccak AEAD primitives crypto/blob.ts needs, plus the full
// lc_kyber_1024_x448 KEM triplet. Only kemDecapsulate is ever called from
// real ui/ application code (unwrapping a shared document's txtKey --
// Encapsulate/keypair generation are admin-only actions performed by
// txt.ts); kemKeypair/kemEncapsulate exist so this module's own tests (and
// library.test.ts's shared-document fixtures) can build real KEM ciphertexts
// to decapsulate against, rather than mocking crypto internals -- this
// project's own stated testing philosophy (real building blocks, not
// mocks).
//
// Real browser-like runtimes fetch() the glue bytes, verify their SHA-512
// against __LEANCRYPTO_JS_INTEGRITY__, then import the result as a real ES
// module from a blob: URL. leancrypto.js's own tail leaves `leancrypto` as a
// plain top-level `var`; appending an `export default` reference turns that
// into a valid ES module. Node/Vitest uses a plain dynamic import(), which
// interoperates with leancrypto.js's own module.exports directly.

import { isWeb } from "../env";
import { bytesToBase64 } from "../crypto/bytes";

// Baked in by vite.config.ts's `define` (a SHA-512 of leancrypto/leancrypto.js
// computed at build time).
declare const __LEANCRYPTO_JS_INTEGRITY__: string;

interface LeanCryptoModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _lc_sha3_512: number;
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
  _lc_ak_alloc_taglen(hash: number, tagLen: number, ctxPtrPtr: number): number;
  _lc_aead_setkey(
    ctx: number,
    key: number,
    keyLen: number,
    iv: number,
    ivLen: number,
  ): number;
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
  _lc_seeded_rng: number;
  _lc_kyber_1024_x448_keypair(pk: number, sk: number, rng: number): number;
  _lc_kyber_1024_x448_enc(ct: number, ss: number, pk: number): number;
  _lc_kyber_1024_x448_dec(ss: number, ct: number, sk: number): number;
}

type LeanCryptoFactory = (
  opts?: Record<string, unknown>,
) => Promise<LeanCryptoModule>;

async function loadWebFactory(): Promise<LeanCryptoFactory> {
  const res = await fetch("/leancrypto.js");
  if (!res.ok)
    throw new Error(`failed to fetch /leancrypto.js: HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-512", bytes);
  const actual = `sha512-${bytesToBase64(new Uint8Array(digest))}`;
  if (actual !== __LEANCRYPTO_JS_INTEGRITY__) {
    throw new Error(
      "leancrypto.js failed integrity check -- refusing to load it",
    );
  }

  const source = new TextDecoder().decode(bytes);
  const blob = new Blob([source, "\nexport default leancrypto;\n"], {
    type: "text/javascript",
  });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as {
      default?: LeanCryptoFactory;
    };
    if (typeof mod.default !== "function") {
      throw new Error(
        "leancrypto.js did not provide a callable default export",
      );
    }
    return mod.default;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function loadNodeFactory(): Promise<LeanCryptoFactory> {
  // @vite-ignore: this path only ever runs under Node/Vitest (see isWeb(),
  // used below) -- keep Vite's client bundler from resolving/inlining it
  // into the browser build.
  const imported: unknown = await import(
    /* @vite-ignore */ "../../../leancrypto/leancrypto.js"
  );
  const mod = imported as { default?: LeanCryptoFactory };
  const factory = mod.default ?? (imported as LeanCryptoFactory);
  if (typeof factory !== "function") {
    throw new Error("leancrypto.js did not provide a callable default export");
  }
  return factory;
}

let modulePromise: Promise<LeanCryptoModule> | null = null;

/** Resolves once the wasm module is instantiated, memoized per realm. */
function loadLeanCrypto(): Promise<LeanCryptoModule> {
  if (!modulePromise) {
    modulePromise = (isWeb() ? loadWebFactory() : loadNodeFactory()).then(
      (factory) =>
        isWeb()
          ? factory({ locateFile: (path: string) => `/${path}` })
          : factory(),
    );
  }
  return modulePromise;
}

// lc_sha3_512 is a C `extern struct lc_hash *`, i.e. a pointer variable, not
// a struct -- this wasm build exposes it as a PIC-style GOT global:
// `Module._lc_sha3_512` is the *address of the pointer variable*, not the
// pointer's value. One more dereference recovers the value lc_hkdf/
// lc_ak_alloc_taglen actually expect as their "hash type" argument (mirrors
// txt/crypto.ts's own deref()).
function deref(mod: LeanCryptoModule, gotAddr: number): number {
  return mod.HEAPU32[gotAddr / 4]!;
}

function writeBuffer(mod: LeanCryptoModule, data: Uint8Array): number {
  const ptr = mod._malloc(data.length || 1);
  mod.HEAPU8.set(data, ptr);
  return ptr;
}

function readBuffer(
  mod: LeanCryptoModule,
  ptr: number,
  len: number,
): Uint8Array {
  return mod.HEAPU8.slice(ptr, ptr + len);
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

/** HKDF-SHA3-512(ikm, salt) -> length bytes of OKM for crypto/blob.ts. */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const mod = await loadLeanCrypto();
  const sha3_512 = deref(mod, mod._lc_sha3_512);
  const ikmPtr = writeBuffer(mod, ikm);
  const saltPtr = writeBuffer(mod, salt);
  const outPtr = mod._malloc(length || 1);
  try {
    const ret = mod._lc_hkdf(
      sha3_512,
      ikmPtr,
      ikm.length,
      saltPtr,
      salt.length,
      0,
      0,
      outPtr,
      length,
    );
    check(ret, "lc_hkdf");
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

function withAeadCtx<T>(
  mod: LeanCryptoModule,
  sha3_512: number,
  tagLen: number,
  fn: (ctx: number) => T,
): T {
  const ctxPtrPtr = mod._malloc(4);
  let ctx = 0;
  try {
    const rc = mod._lc_ak_alloc_taglen(sha3_512, tagLen, ctxPtrPtr);
    check(rc, "lc_ak_alloc_taglen");
    ctx = mod.HEAPU32[ctxPtrPtr / 4]!;
    return fn(ctx);
  } finally {
    if (ctx) mod._lc_aead_zero_free(ctx);
    mod._free(ctxPtrPtr);
  }
}

/** AEAD encrypt (Ascon-Keccak, keyed by HKDF-derived key/iv -- see crypto/blob.ts). */
export async function aeadEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  tagLen: number,
): Promise<AeadResult> {
  const mod = await loadLeanCrypto();
  const sha3_512 = deref(mod, mod._lc_sha3_512);
  return withAeadCtx(mod, sha3_512, tagLen, (ctx) => {
    const keyPtr = writeBuffer(mod, key);
    const ivPtr = writeBuffer(mod, iv);
    const aadPtr = writeBuffer(mod, aad);
    const ptPtr = writeBuffer(mod, plaintext);
    const ctPtr = mod._malloc(plaintext.length || 1);
    const tagPtr = mod._malloc(tagLen);
    try {
      const setRc = mod._lc_aead_setkey(
        ctx,
        keyPtr,
        key.length,
        ivPtr,
        iv.length,
      );
      check(setRc, "lc_aead_setkey");
      const rc = mod._lc_aead_encrypt(
        ctx,
        ptPtr,
        ctPtr,
        plaintext.length,
        aadPtr,
        aad.length,
        tagPtr,
        tagLen,
      );
      check(rc, "lc_aead_encrypt");
      return {
        ciphertext: readBuffer(mod, ctPtr, plaintext.length),
        tag: readBuffer(mod, tagPtr, tagLen),
      };
    } finally {
      mod._free(keyPtr);
      mod._free(ivPtr);
      mod._free(aadPtr);
      mod._free(ptPtr);
      mod._free(ctPtr);
      mod._free(tagPtr);
    }
  });
}

/** AEAD decrypt; throws LeanCryptoError if tag verification fails. */
export async function aeadDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Promise<Uint8Array> {
  const mod = await loadLeanCrypto();
  const sha3_512 = deref(mod, mod._lc_sha3_512);
  return withAeadCtx(mod, sha3_512, tag.length, (ctx) => {
    const keyPtr = writeBuffer(mod, key);
    const ivPtr = writeBuffer(mod, iv);
    const aadPtr = writeBuffer(mod, aad);
    const ctPtr = writeBuffer(mod, ciphertext);
    const tagPtr = writeBuffer(mod, tag);
    const ptPtr = mod._malloc(ciphertext.length || 1);
    try {
      const setRc = mod._lc_aead_setkey(
        ctx,
        keyPtr,
        key.length,
        ivPtr,
        iv.length,
      );
      check(setRc, "lc_aead_setkey");
      const rc = mod._lc_aead_decrypt(
        ctx,
        ctPtr,
        ptPtr,
        ciphertext.length,
        aadPtr,
        aad.length,
        tagPtr,
        tag.length,
      );
      check(rc, "lc_aead_decrypt (auth failure)");
      return readBuffer(mod, ptPtr, ciphertext.length);
    } finally {
      mod._free(keyPtr);
      mod._free(ivPtr);
      mod._free(aadPtr);
      mod._free(ctPtr);
      mod._free(tagPtr);
      mod._free(ptPtr);
    }
  });
}

const KEM_PUB_KEY_LEN = 1624;
const KEM_CT_LEN = 1624;
const KEM_SS_LEN = 88;
const KEM_PRIV_KEY_LEN = 3224;

export interface KemKeypair {
  pubKey: Uint8Array;
  privKey: Uint8Array;
}

/** Test-only in real ui/ application code (see this file's header comment) --
 * generates a fresh lc_kyber_1024_x448 composite keypair. */
export async function kemKeypair(): Promise<KemKeypair> {
  const mod = await loadLeanCrypto();
  const seededRng = deref(mod, mod._lc_seeded_rng);
  const pkPtr = mod._malloc(KEM_PUB_KEY_LEN);
  const skPtr = mod._malloc(KEM_PRIV_KEY_LEN);
  try {
    const rc = mod._lc_kyber_1024_x448_keypair(pkPtr, skPtr, seededRng);
    check(rc, "lc_kyber_1024_x448_keypair");
    return {
      pubKey: readBuffer(mod, pkPtr, KEM_PUB_KEY_LEN),
      privKey: readBuffer(mod, skPtr, KEM_PRIV_KEY_LEN),
    };
  } finally {
    mod._free(pkPtr);
    mod._free(skPtr);
  }
}

export interface KemEncapsulation {
  ct: Uint8Array;
  ss: Uint8Array;
}

/** Test-only in real ui/ application code (see this file's header comment) --
 * crypto.md's Encapsulate step 2: KEM ciphertext + the raw, uncombined
 * shared secret. */
export async function kemEncapsulate(
  pubKey: Uint8Array,
): Promise<KemEncapsulation> {
  const mod = await loadLeanCrypto();
  const pkPtr = writeBuffer(mod, pubKey);
  const ctPtr = mod._malloc(KEM_CT_LEN);
  const ssPtr = mod._malloc(KEM_SS_LEN);
  try {
    const rc = mod._lc_kyber_1024_x448_enc(ctPtr, ssPtr, pkPtr);
    check(rc, "lc_kyber_1024_x448_enc");
    return {
      ct: readBuffer(mod, ctPtr, KEM_CT_LEN),
      ss: readBuffer(mod, ssPtr, KEM_SS_LEN),
    };
  } finally {
    mod._free(pkPtr);
    mod._free(ctPtr);
    mod._free(ssPtr);
  }
}

/** crypto.md's Decapsulate step 2: recovers the raw 88-byte shared secret
 * from a KEM ciphertext using this account's own composite privKey -- the
 * one KEM operation ui/ ever needs (to unwrap a txtShares grant's txtKey). */
export async function kemDecapsulate(
  privKey: Uint8Array,
  ct: Uint8Array,
): Promise<Uint8Array> {
  if (privKey.length !== KEM_PRIV_KEY_LEN) {
    throw new Error(
      `kemDecapsulate: privKey must be ${KEM_PRIV_KEY_LEN} bytes, got ${privKey.length}`,
    );
  }
  if (ct.length !== KEM_CT_LEN) {
    throw new Error(
      `kemDecapsulate: ct must be ${KEM_CT_LEN} bytes, got ${ct.length}`,
    );
  }
  const mod = await loadLeanCrypto();
  const skPtr = writeBuffer(mod, privKey);
  const ctPtr = writeBuffer(mod, ct);
  const ssPtr = mod._malloc(KEM_SS_LEN);
  try {
    const rc = mod._lc_kyber_1024_x448_dec(ssPtr, ctPtr, skPtr);
    check(rc, "lc_kyber_1024_x448_dec");
    return readBuffer(mod, ssPtr, KEM_SS_LEN);
  } finally {
    mod._free(skPtr);
    mod._free(ctPtr);
    mod._free(ssPtr);
  }
}
