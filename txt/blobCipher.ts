// Implements docs/crypto.md's blob format (magic||version||salt||ciphertext||tag)
// and its Encrypt/Decrypt procedures via leancrypto's lc_wasm_* wrappers.

import { randomBytes } from "node:crypto";
import { type WasmModule, loadWasm, writeBuffer, readBuffer } from "./wasm.ts";

const MAGIC = Buffer.from([0x54, 0x58]);
const VERSION = Buffer.from([0x01, 0x00]);
const HEADER_LEN = 68; // magic(2) + version(2) + salt(64)
const TAG_LEN = 64;
const MIN_BLOB_LEN = HEADER_LEN + TAG_LEN;

export class BlobCipher {
  private readonly mod: WasmModule;

  private constructor(mod: WasmModule) {
    this.mod = mod;
  }

  static async create(): Promise<BlobCipher> {
    return new BlobCipher(await loadWasm());
  }

  encrypt(ikm: Uint8Array, plaintext: Uint8Array): Buffer {
    const salt = randomBytes(64);
    const ad = Buffer.concat([MAGIC, VERSION, salt]);
    const { key, iv } = this.deriveKeyIv(ikm, salt);
    const { ciphertext, tag } = this.aeadEncrypt(key, iv, ad, plaintext);
    return Buffer.concat([ad, ciphertext, tag]);
  }

  decrypt(ikm: Uint8Array, blob: Uint8Array): Buffer {
    if (blob.length < MIN_BLOB_LEN) throw new Error("blob shorter than minimum valid length");
    if (blob[0] !== MAGIC[0] || blob[1] !== MAGIC[1]) throw new Error("bad blob magic");
    const salt = blob.subarray(4, HEADER_LEN);
    const ad = blob.subarray(0, HEADER_LEN);
    const ciphertext = blob.subarray(HEADER_LEN, blob.length - TAG_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const { key, iv } = this.deriveKeyIv(ikm, salt);
    return this.aeadDecrypt(key, iv, ad, ciphertext, tag);
  }

  private deriveKeyIv(ikm: Uint8Array, salt: Uint8Array): { key: Buffer; iv: Buffer } {
    const okm = this.hkdf(ikm, salt);
    return { key: okm.subarray(0, 64), iv: okm.subarray(64, 128) };
  }

  private hkdf(ikm: Uint8Array, salt: Uint8Array): Buffer {
    const [ikmPtr, saltPtr] = [writeBuffer(this.mod, ikm), writeBuffer(this.mod, salt)];
    const okmPtr = this.mod._malloc(128);
    const rc = this.mod._lc_wasm_hkdf_sha3_512(
      ikmPtr,
      ikm.length,
      saltPtr,
      salt.length,
      0,
      0,
      okmPtr,
      128,
    );
    const okm = readBuffer(this.mod, okmPtr, 128);
    this.free(ikmPtr, saltPtr, okmPtr);
    if (rc !== 0) throw new Error(`lc_wasm_hkdf_sha3_512 failed: rc=${rc}`);
    return okm;
  }

  private aeadEncrypt(key: Uint8Array, iv: Uint8Array, ad: Uint8Array, pt: Uint8Array) {
    const ptrs = [key, iv, ad, pt].map((b) => writeBuffer(this.mod, b));
    const ctPtr = this.mod._malloc(pt.length || 1);
    const tagPtr = this.mod._malloc(TAG_LEN);
    const rc = this.mod._lc_wasm_aead_encrypt(
      ptrs[0]!,
      64,
      ptrs[1]!,
      64,
      ptrs[2]!,
      ad.length,
      ptrs[3]!,
      pt.length,
      ctPtr,
      tagPtr,
      TAG_LEN,
    );
    const result = {
      ciphertext: readBuffer(this.mod, ctPtr, pt.length),
      tag: readBuffer(this.mod, tagPtr, TAG_LEN),
    };
    this.free(...ptrs, ctPtr, tagPtr);
    if (rc !== 0) throw new Error(`lc_wasm_aead_encrypt failed: rc=${rc}`);
    return result;
  }

  private aeadDecrypt(
    key: Uint8Array,
    iv: Uint8Array,
    ad: Uint8Array,
    ct: Uint8Array,
    tag: Uint8Array,
  ): Buffer {
    const ptrs = [key, iv, ad, ct, tag].map((b) => writeBuffer(this.mod, b));
    const ptPtr = this.mod._malloc(ct.length || 1);
    const rc = this.mod._lc_wasm_aead_decrypt(
      ptrs[0]!,
      64,
      ptrs[1]!,
      64,
      ptrs[2]!,
      ad.length,
      ptrs[3]!,
      ct.length,
      ptPtr,
      ptrs[4]!,
      TAG_LEN,
    );
    const plaintext = readBuffer(this.mod, ptPtr, ct.length);
    this.free(...ptrs, ptPtr);
    if (rc !== 0) throw new Error(`lc_wasm_aead_decrypt failed: rc=${rc} (auth failure)`);
    return plaintext;
  }

  private free(...ptrs: number[]): void {
    for (const p of ptrs) this.mod._free(p);
  }
}
