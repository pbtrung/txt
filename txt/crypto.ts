// Ascon-Keccak AEAD + HKDF-SHA3-512 (docs/crypto.md's Blob format), via the
// prebuilt sqlcipher/sqlcipher.js WASM module -- never hand-rolled. Native
// Node crypto covers HMAC-SHA3-256 (username_hash), a standard primitive
// with no leancrypto-specific behavior to replicate.
import { createHmac, randomBytes } from "node:crypto";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
// @ts-ignore -- no type declarations beyond `declare function Sqlite3Wasm(): Promise<any>`
import Sqlite3Wasm from "../sqlcipher/sqlcipher.js";
import * as C from "./constants.ts";
import { WasmMem } from "./wasmMem.ts";

export class BlobDecryptError extends Error {}

interface ParsedBlob {
  ad: Uint8Array;
  salt: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

function parseBlob(blob: Uint8Array): ParsedBlob {
  if (blob.length < C.BLOB_MIN_LEN) {
    throw new Error(
      `blob shorter than minimum valid length (${blob.length} < ${C.BLOB_MIN_LEN})`,
    );
  }
  if (blob[0] !== C.MAGIC[0] || blob[1] !== C.MAGIC[1])
    throw new Error("bad blob magic");
  if (blob[2] !== C.VERSION_MAJOR)
    throw new Error(`unsupported blob major version: ${blob[2]}`);
  return {
    ad: blob.subarray(0, C.AD_LEN),
    salt: blob.subarray(C.HEADER_LEN, C.AD_LEN),
    ciphertext: blob.subarray(C.AD_LEN, blob.length - C.TAG_LEN),
    tag: blob.subarray(blob.length - C.TAG_LEN),
  };
}

function checkWasmSizes(mod: any): void {
  const key = mod._lc_wasm_key_size();
  const nonce = mod._lc_wasm_nonce_size();
  const tag = mod._lc_wasm_tag_size();
  if (key !== C.KEY_LEN || nonce !== C.IV_LEN || tag !== C.TAG_LEN) {
    throw new Error(
      `unexpected leancrypto wasm sizes: key=${key} nonce=${nonce} tag=${tag}`,
    );
  }
}

export class CryptoEngine {
  private module: any;
  private mem: WasmMem;

  private constructor(module: any, mem: WasmMem) {
    this.module = module;
    this.mem = mem;
  }

  static async create(): Promise<CryptoEngine> {
    const module = await Sqlite3Wasm();
    checkWasmSizes(module);
    return new CryptoEngine(module, new WasmMem(module));
  }

  usernameHash(usernameLookupKey: Buffer, username: string): Buffer {
    return createHmac("sha3-256", usernameLookupKey)
      .update(username, "utf8")
      .digest();
  }

  // compressed must match the value passed to blobEncrypt for this blob --
  // there's no in-blob flag recording it (docs/crypto.md's format has none),
  // so the caller is the one source of truth for whether a given field's
  // payload is a structured (e.g. JSON) one worth compressing.
  blobDecrypt(ikm: Uint8Array, blob: Uint8Array, compressed: boolean): Buffer {
    const { ad, salt, ciphertext, tag } = parseBlob(blob);
    const { key, iv } = this.deriveKeyIv(ikm, salt);
    const plaintext = this.aeadDecrypt(key, iv, ad, ciphertext, tag);
    return compressed ? brotliDecompressSync(plaintext) : plaintext;
  }

  // crypto.md's Encrypt algorithm: brotli-compress first if this is a
  // structured (e.g. JSON) payload, fresh salt, HKDF-derive key+IV from it,
  // AEAD-encrypt with AD = magic||version||salt, assemble the blob.
  blobEncrypt(
    ikm: Uint8Array,
    plaintext: Uint8Array,
    compressed: boolean,
  ): Buffer {
    const payload = compressed
      ? brotliCompressSync(plaintext, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: C.BROTLI_QUALITY },
        })
      : plaintext;
    const salt = randomBytes(C.SALT_LEN);
    const ad = Buffer.from([
      ...C.MAGIC,
      C.VERSION_MAJOR,
      C.VERSION_MINOR,
      ...salt,
    ]);
    const { key, iv } = this.deriveKeyIv(ikm, salt);
    const { ciphertext, tag } = this.aeadEncrypt(key, iv, ad, payload);
    return Buffer.concat([ad, ciphertext, tag]);
  }

  private deriveKeyIv(
    ikm: Uint8Array,
    salt: Uint8Array,
  ): { key: Buffer; iv: Buffer } {
    const okm = this.hkdfSha3512(ikm, salt, C.OKM_LEN);
    return {
      key: okm.subarray(0, C.KEY_LEN),
      iv: okm.subarray(C.KEY_LEN, C.OKM_LEN),
    };
  }

  private hkdfSha3512(
    ikm: Uint8Array,
    salt: Uint8Array,
    outLen: number,
  ): Buffer {
    return this.mem.withBuffers({ ikm, salt }, { out: outLen }, (p) => {
      const rc = this.module._lc_wasm_hkdf_sha3_512(
        p.ikm,
        ikm.length,
        p.salt,
        salt.length,
        0,
        0,
        p.out,
        outLen,
      );
      if (rc !== 0) throw new Error(`lc_wasm_hkdf_sha3_512 failed, rc=${rc}`);
      return this.mem.read(p.out, outLen);
    });
  }

  private aeadDecrypt(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    ct: Uint8Array,
    tag: Uint8Array,
  ): Buffer {
    return this.mem.withBuffers(
      { key, iv, aad, ct, tag },
      { pt: ct.length },
      (p) => {
        const rc = this.runAeadDecrypt(
          p,
          key.length,
          iv.length,
          aad.length,
          ct.length,
          tag.length,
        );
        return rc;
      },
    );
  }

  private runAeadDecrypt(
    p: Record<string, number>,
    keyLen: number,
    ivLen: number,
    aadLen: number,
    ctLen: number,
    tagLen: number,
  ): Buffer {
    const rc = this.module._lc_wasm_aead_decrypt(
      p.key,
      keyLen,
      p.iv,
      ivLen,
      p.aad,
      aadLen,
      p.ct,
      ctLen,
      p.pt,
      p.tag,
      tagLen,
    );
    if (rc !== 0) throw new BlobDecryptError("AEAD tag verification failed");
    return this.mem.read(p.pt, ctLen);
  }

  private aeadEncrypt(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    pt: Uint8Array,
  ): { ciphertext: Buffer; tag: Buffer } {
    return this.mem.withBuffers(
      { key, iv, aad, pt },
      { ct: pt.length, tag: C.TAG_LEN },
      (p) =>
        this.runAeadEncrypt(p, key.length, iv.length, aad.length, pt.length),
    );
  }

  private runAeadEncrypt(
    p: Record<string, number>,
    keyLen: number,
    ivLen: number,
    aadLen: number,
    ptLen: number,
  ): { ciphertext: Buffer; tag: Buffer } {
    const rc = this.module._lc_wasm_aead_encrypt(
      p.key,
      keyLen,
      p.iv,
      ivLen,
      p.aad,
      aadLen,
      p.pt,
      ptLen,
      p.ct,
      p.tag,
      C.TAG_LEN,
    );
    if (rc !== 0) throw new Error(`lc_wasm_aead_encrypt failed, rc=${rc}`);
    return {
      ciphertext: this.mem.read(p.ct, ptLen),
      tag: this.mem.read(p.tag, C.TAG_LEN),
    };
  }
}
