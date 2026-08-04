// Ascon-Keccak AEAD + HKDF-SHA3-512 (docs/crypto.md's Blob format) and the
// lc_kyber_1024_x448 composite KEM (docs/crypto.md's Encapsulate/Decapsulate),
// via the vendored leancrypto WASM module (leancrypto/leancrypto.js, shared
// with ui/) -- never hand-rolled. Native Node crypto covers HMAC-SHA3-256
// (username_hash), a standard primitive with no leancrypto-specific behavior
// to replicate.
import { createHmac, randomBytes } from "node:crypto";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
// @ts-ignore -- no type declarations beyond `declare function factory(): Promise<any>`
import leancryptoFactory from "../leancrypto/leancrypto.js";
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

// lc_sha3_512/lc_seeded_rng are C `extern <type> *name;` globals (pointers,
// not structs) -- this wasm build exposes them as PIC-style GOT globals:
// `Module._lc_sha3_512` is the *address of the pointer variable*, not the
// pointer's value. One more dereference is required before passing the
// result as the "hash type" argument to lc_hkdf/lc_ak_alloc_taglen (or
// lc_seeded_rng before lc_kyber_1024_x448_keypair) -- skipping it crashes
// with "RuntimeError: table index is out of bounds".
function deref(mod: any, gotAddr: number): number {
  return mod.HEAPU32[gotAddr / 4];
}

const KEM_PUB_KEY_LEN = 1624;
const KEM_PRIV_KEY_LEN = 3224;
const KEM_CT_LEN = 1624;
const KEM_SS_LEN = 88;

export interface KemKeypair {
  pubKey: Buffer;
  privKey: Buffer;
}

export interface KemEncapsulation {
  ct: Buffer;
  ss: Buffer;
}

export class CryptoEngine {
  private module: any;
  private mem: WasmMem;
  private sha3_512: number;
  private seededRng: number;

  private constructor(
    module: any,
    mem: WasmMem,
    sha3_512: number,
    seededRng: number,
  ) {
    this.module = module;
    this.mem = mem;
    this.sha3_512 = sha3_512;
    this.seededRng = seededRng;
  }

  static async create(): Promise<CryptoEngine> {
    const module = await leancryptoFactory();
    const sha3_512 = deref(module, module._lc_sha3_512);
    const seededRng = deref(module, module._lc_seeded_rng);
    return new CryptoEngine(module, new WasmMem(module), sha3_512, seededRng);
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

  // Composite KEM keypair generation (crypto.md's Composite KEM Key Sizes) --
  // pubKey raw (1624 bytes, not sensitive), privKey raw (3224 bytes, caller's
  // job to wrap under the owner's own intermediate key before storing).
  kemKeypair(): KemKeypair {
    return this.mem.withBuffers(
      {},
      { pk: KEM_PUB_KEY_LEN, sk: KEM_PRIV_KEY_LEN },
      (p) => {
        const rc = this.module._lc_kyber_1024_x448_keypair(
          p.pk,
          p.sk,
          this.seededRng,
        );
        if (rc !== 0) {
          throw new Error(`lc_kyber_1024_x448_keypair failed, rc=${rc}`);
        }
        return {
          pubKey: this.mem.read(p.pk, KEM_PUB_KEY_LEN),
          privKey: this.mem.read(p.sk, KEM_PRIV_KEY_LEN),
        };
      },
    );
  }

  // crypto.md's Encapsulate step 2: KEM ciphertext (1624 bytes) + the raw,
  // uncombined 88-byte shared secret (ML-KEM-1024-SS || X448-SS) -- the
  // caller still has to run the standard Encrypt (via blobEncrypt, reusing
  // its own fresh salt per crypto.md) with ss as IKM to finish wrapping the
  // shared key material.
  kemEncapsulate(pubKey: Buffer): KemEncapsulation {
    return this.mem.withBuffers(
      { pk: pubKey },
      { ct: KEM_CT_LEN, ss: KEM_SS_LEN },
      (p) => {
        const rc = this.module._lc_kyber_1024_x448_enc(p.ct, p.ss, p.pk);
        if (rc !== 0) {
          throw new Error(`lc_kyber_1024_x448_enc failed, rc=${rc}`);
        }
        return {
          ct: this.mem.read(p.ct, KEM_CT_LEN),
          ss: this.mem.read(p.ss, KEM_SS_LEN),
        };
      },
    );
  }

  // crypto.md's Decapsulate step 2: recovers the same raw 88-byte ss from a
  // KEM ciphertext using this account's own composite privKey.
  kemDecapsulate(privKey: Buffer, ct: Buffer): Buffer {
    return this.mem.withBuffers(
      { sk: privKey, ct },
      { ss: KEM_SS_LEN },
      (p) => {
        const rc = this.module._lc_kyber_1024_x448_dec(p.ss, p.ct, p.sk);
        if (rc !== 0)
          throw new Error(`lc_kyber_1024_x448_dec failed, rc=${rc}`);
        return this.mem.read(p.ss, KEM_SS_LEN);
      },
    );
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
      const rc = this.module._lc_hkdf(
        this.sha3_512,
        p.ikm,
        ikm.length,
        p.salt,
        salt.length,
        0,
        0,
        p.out,
        outLen,
      );
      if (rc !== 0) throw new Error(`lc_hkdf failed, rc=${rc}`);
      return this.mem.read(p.out, outLen);
    });
  }

  // Unlike the old sqlcipher.js-embedded wrapper (a single _lc_wasm_aead_*
  // call each), this WASM build's own raw AEAD API is a real
  // alloc/setkey/run/free lifecycle around one lc_aead_ctx.
  private withAeadCtx<T>(tagLen: number, fn: (ctx: number) => T): T {
    const ctxPtrPtr = this.module._malloc(4);
    let ctx = 0;
    try {
      const rc = this.module._lc_ak_alloc_taglen(
        this.sha3_512,
        tagLen,
        ctxPtrPtr,
      );
      if (rc !== 0) throw new Error(`lc_ak_alloc_taglen failed, rc=${rc}`);
      ctx = this.module.HEAPU32[ctxPtrPtr / 4];
      return fn(ctx);
    } finally {
      if (ctx) this.module._lc_aead_zero_free(ctx);
      this.module._free(ctxPtrPtr);
    }
  }

  private aeadDecrypt(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    ct: Uint8Array,
    tag: Uint8Array,
  ): Buffer {
    return this.withAeadCtx(tag.length, (ctx) =>
      this.mem.withBuffers(
        { key, iv, aad, ct, tag },
        { pt: ct.length },
        (p) => {
          const setRc = this.module._lc_aead_setkey(
            ctx,
            p.key,
            key.length,
            p.iv,
            iv.length,
          );
          if (setRc !== 0)
            throw new Error(`lc_aead_setkey failed, rc=${setRc}`);
          const rc = this.module._lc_aead_decrypt(
            ctx,
            p.ct,
            p.pt,
            ct.length,
            p.aad,
            aad.length,
            p.tag,
            tag.length,
          );
          if (rc !== 0)
            throw new BlobDecryptError("AEAD tag verification failed");
          return this.mem.read(p.pt, ct.length);
        },
      ),
    );
  }

  private aeadEncrypt(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    pt: Uint8Array,
  ): { ciphertext: Buffer; tag: Buffer } {
    return this.withAeadCtx(C.TAG_LEN, (ctx) =>
      this.mem.withBuffers(
        { key, iv, aad, pt },
        { ct: pt.length, tag: C.TAG_LEN },
        (p) => {
          const setRc = this.module._lc_aead_setkey(
            ctx,
            p.key,
            key.length,
            p.iv,
            iv.length,
          );
          if (setRc !== 0)
            throw new Error(`lc_aead_setkey failed, rc=${setRc}`);
          const rc = this.module._lc_aead_encrypt(
            ctx,
            p.pt,
            p.ct,
            pt.length,
            p.aad,
            aad.length,
            p.tag,
            C.TAG_LEN,
          );
          if (rc !== 0) throw new Error(`lc_aead_encrypt failed, rc=${rc}`);
          return {
            ciphertext: this.mem.read(p.ct, pt.length),
            tag: this.mem.read(p.tag, C.TAG_LEN),
          };
        },
      ),
    );
  }
}
