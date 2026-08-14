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
    handlePromise = getSqlcipherModule().then((mod) => ({
      mod,
      keySize: mod._lc_wasm_key_size(),
      nonceSize: mod._lc_wasm_nonce_size(),
      tagSize: mod._lc_wasm_tag_size(),
    }));
  }
  return handlePromise;
}

function writeBytes(mod: SqlcipherWasmModule, bytes: Uint8Array): number {
  const ptr = mod._malloc(bytes.length || 1);
  mod.HEAPU8.set(bytes, ptr);
  return ptr;
}

function readBytes(mod: SqlcipherWasmModule, ptr: number, len: number): Uint8Array {
  return mod.HEAPU8.slice(ptr, ptr + len);
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

/** HKDF-SHA3-512(ikm, salt, info) -> length bytes of OKM. */
export async function hkdfSha3_512(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const { mod } = await getAead();
  const ikmPtr = writeBytes(mod, ikm);
  const saltPtr = writeBytes(mod, salt);
  const infoPtr = writeBytes(mod, info);
  const outPtr = mod._malloc(length || 1);
  try {
    const rc = mod._lc_wasm_hkdf_sha3_512(ikmPtr, ikm.length, saltPtr, salt.length, infoPtr, info.length, outPtr, length);
    check(rc, "lc_wasm_hkdf_sha3_512");
    return readBytes(mod, outPtr, length);
  } finally {
    mod._free(ikmPtr);
    mod._free(saltPtr);
    mod._free(infoPtr);
    mod._free(outPtr);
  }
}

export interface Sealed {
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
  const keyPtr = writeBytes(mod, key);
  const noncePtr = writeBytes(mod, nonce);
  const aadPtr = writeBytes(mod, aad);
  const ptPtr = writeBytes(mod, plaintext);
  const ctPtr = mod._malloc(plaintext.length || 1);
  const tagPtr = mod._malloc(tagSize);
  try {
    const rc = mod._lc_wasm_aead_encrypt(
      keyPtr, keySize, noncePtr, nonceSize, aadPtr, aad.length,
      ptPtr, plaintext.length, ctPtr, tagPtr, tagSize,
    );
    check(rc, "lc_wasm_aead_encrypt");
    return { ciphertext: readBytes(mod, ctPtr, plaintext.length), tag: readBytes(mod, tagPtr, tagSize) };
  } finally {
    mod._free(keyPtr); mod._free(noncePtr); mod._free(aadPtr);
    mod._free(ptPtr); mod._free(ctPtr); mod._free(tagPtr);
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
  const keyPtr = writeBytes(mod, key);
  const noncePtr = writeBytes(mod, nonce);
  const aadPtr = writeBytes(mod, aad);
  const ctPtr = writeBytes(mod, ciphertext);
  const tagPtr = writeBytes(mod, tag);
  const ptPtr = mod._malloc(ciphertext.length || 1);
  try {
    const rc = mod._lc_wasm_aead_decrypt(
      keyPtr, keySize, noncePtr, nonceSize, aadPtr, aad.length,
      ctPtr, ciphertext.length, ptPtr, tagPtr, tagSize,
    );
    check(rc, "lc_wasm_aead_decrypt");
    return readBytes(mod, ptPtr, ciphertext.length);
  } finally {
    mod._free(keyPtr); mod._free(noncePtr); mod._free(aadPtr);
    mod._free(ctPtr); mod._free(tagPtr); mod._free(ptPtr);
  }
}
