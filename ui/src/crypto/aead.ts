// Thin wrappers over sqlcipher.wasm's raw leancrypto exports, mirroring
// txt/leancrypto_wasm.py's hkdf_sha3_512/aead_encrypt/aead_decrypt call
// shapes 1:1 (argument order confirmed against sqlcipher/test-roundtrip.mjs's
// own calls, not guessed).
import { getSqlcipherModule } from "./sqlcipherLoader";
import type { SqlcipherWasmModule } from "./sqlcipherLoader";

interface AeadHandle {
  mod: SqlcipherWasmModule;
  keySize: number;
  nonceSize: number;
  tagSize: number;
}

let handlePromise: Promise<AeadHandle> | null = null;

function getAead(): Promise<AeadHandle> {
  if (!handlePromise) {
    handlePromise = getSqlcipherModule()
      .then((mod) => ({
        mod,
        keySize: mod._lc_wasm_key_size(),
        nonceSize: mod._lc_wasm_nonce_size(),
        tagSize: mod._lc_wasm_tag_size(),
      }))
      .catch((error: unknown) => {
        // Don't strand every future call behind one transient failure (a
        // flaky wasm load, say) -- let the next getAead() retry from
        // scratch instead of replaying this same rejection forever.
        handlePromise = null;
        throw error;
      });
  }
  return handlePromise;
}

function readBytes(mod: SqlcipherWasmModule, ptr: number, len: number): Uint8Array {
  return mod.HEAPU8.slice(ptr, ptr + len);
}

// Tracks every pointer allocated through it so a throw partway through a
// multi-buffer setup (e.g. _malloc failing on a later buffer) still frees
// whatever was already allocated, instead of leaking wasm linear memory.
class WasmArena {
  private readonly pointers: number[] = [];

  constructor(private readonly mod: SqlcipherWasmModule) {}

  malloc(size: number): number {
    const ptr = this.mod._malloc(size);
    this.pointers.push(ptr);
    return ptr;
  }

  write(bytes: Uint8Array): number {
    const ptr = this.malloc(bytes.length || 1);
    this.mod.HEAPU8.set(bytes, ptr);
    return ptr;
  }

  free(): void {
    for (const ptr of this.pointers) this.mod._free(ptr);
  }
}

class AeadError extends Error {
  constructor(what: string, ret: number) {
    super(`${what} failed: ${ret}`);
    this.name = "AeadError";
  }
}

function check(ret: number, what: string): void {
  if (ret !== 0) {
    throw new AeadError(what, ret);
  }
}

function requireSize(bytes: Uint8Array, expected: number, name: string): void {
  if (bytes.length !== expected) {
    throw new Error(`${name} must be exactly ${expected} bytes`);
  }
}

function requireOutputLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("HKDF output length must be a non-negative safe integer");
  }
}

/** HKDF-SHA3-512(ikm, salt, info) -> length bytes of OKM. */
export async function hkdfSha3_512(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  requireOutputLength(length);
  const { mod } = await getAead();
  const arena = new WasmArena(mod);
  try {
    const ikmPtr = arena.write(ikm);
    const saltPtr = arena.write(salt);
    const infoPtr = arena.write(info);
    const outPtr = arena.malloc(length || 1);
    const rc = mod._lc_wasm_hkdf_sha3_512(
      ikmPtr,
      ikm.length,
      saltPtr,
      salt.length,
      infoPtr,
      info.length,
      outPtr,
      length,
    );
    check(rc, "lc_wasm_hkdf_sha3_512");
    return readBytes(mod, outPtr, length);
  } finally {
    arena.free();
  }
}

interface Sealed {
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

/** Ascon-Keccak AEAD encrypt (64-byte key/nonce, 64-byte tag). */
export async function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Sealed> {
  const { mod, keySize, nonceSize, tagSize } = await getAead();
  requireSize(key, keySize, "AEAD key");
  requireSize(nonce, nonceSize, "AEAD nonce");
  const arena = new WasmArena(mod);
  try {
    const keyPtr = arena.write(key);
    const noncePtr = arena.write(nonce);
    const aadPtr = arena.write(aad);
    const ptPtr = arena.write(plaintext);
    const ctPtr = arena.malloc(plaintext.length || 1);
    const tagPtr = arena.malloc(tagSize);
    const rc = mod._lc_wasm_aead_encrypt(
      keyPtr,
      keySize,
      noncePtr,
      nonceSize,
      aadPtr,
      aad.length,
      ptPtr,
      plaintext.length,
      ctPtr,
      tagPtr,
      tagSize,
    );
    check(rc, "lc_wasm_aead_encrypt");
    return {
      ciphertext: readBytes(mod, ctPtr, plaintext.length),
      tag: readBytes(mod, tagPtr, tagSize),
    };
  } finally {
    arena.free();
  }
}

/** Ascon-Keccak AEAD decrypt; throws AeadError on authentication failure. */
export async function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Promise<Uint8Array> {
  const { mod, keySize, nonceSize, tagSize } = await getAead();
  requireSize(key, keySize, "AEAD key");
  requireSize(nonce, nonceSize, "AEAD nonce");
  requireSize(tag, tagSize, "AEAD tag");
  const arena = new WasmArena(mod);
  try {
    const keyPtr = arena.write(key);
    const noncePtr = arena.write(nonce);
    const aadPtr = arena.write(aad);
    const ctPtr = arena.write(ciphertext);
    const tagPtr = arena.write(tag);
    const ptPtr = arena.malloc(ciphertext.length || 1);
    const rc = mod._lc_wasm_aead_decrypt(
      keyPtr,
      keySize,
      noncePtr,
      nonceSize,
      aadPtr,
      aad.length,
      ctPtr,
      ciphertext.length,
      ptPtr,
      tagPtr,
      tagSize,
    );
    check(rc, "lc_wasm_aead_decrypt");
    return readBytes(mod, ptPtr, ciphertext.length);
  } finally {
    arena.free();
  }
}
