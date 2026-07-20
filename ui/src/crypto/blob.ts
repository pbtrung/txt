// Encrypt/Decrypt per docs/crypto.md's blob format:
// magic || version || salt || ciphertext || tag.
// Mirrors txt/crypto.py's Blob class exactly -- same field layout, same HKDF
// key/IV split, same optional brotli step for structured (JSON) payloads.

import * as c from "./constants";
import { concatBytes, randomBytes } from "./bytes";
import * as brotli from "./brotli";
import { aeadDecrypt, aeadEncrypt, hkdf } from "./leancryptoLoader";

async function derive(ikm: Uint8Array, salt: Uint8Array): Promise<{ key: Uint8Array; iv: Uint8Array }> {
  const okm = await hkdf(ikm, salt, c.OKM_LEN);
  return { key: okm.slice(0, c.KEY_LEN), iv: okm.slice(c.KEY_LEN) };
}

export interface EncryptOptions {
  salt?: Uint8Array;
  compressed?: boolean;
}

/** compressed:true brotli-compresses payload first, for structured (e.g. JSON) payloads. */
export async function encrypt(ikm: Uint8Array, payload: Uint8Array, options: EncryptOptions = {}): Promise<Uint8Array> {
  const salt = options.salt ?? randomBytes(c.SALT_LEN);
  const plaintext = options.compressed ? await brotli.compress(payload) : payload;
  const { key, iv } = await derive(ikm, salt);
  const ad = concatBytes(c.MAGIC, c.VERSION, salt);
  const { ciphertext, tag } = await aeadEncrypt(key, iv, ad, plaintext, c.TAG_LEN);
  return concatBytes(ad, ciphertext, tag);
}

/** compressed:true must match the compressed value used to encrypt this blob. */
export async function decrypt(ikm: Uint8Array, blob: Uint8Array, compressed = false): Promise<Uint8Array> {
  if (blob.length < c.BLOB_MIN_LEN) {
    throw new Error("blob shorter than minimum valid length");
  }
  if (blob[0] !== c.MAGIC[0] || blob[1] !== c.MAGIC[1]) {
    throw new Error("bad magic");
  }
  if (blob[2] !== c.VERSION[0]) {
    throw new Error("unsupported major version");
  }
  const ad = blob.slice(0, c.AD_LEN);
  const salt = blob.slice(4, c.AD_LEN);
  const ciphertext = blob.slice(c.AD_LEN, blob.length - c.TAG_LEN);
  const tag = blob.slice(blob.length - c.TAG_LEN);
  const { key, iv } = await derive(ikm, salt);
  const plaintext = await aeadDecrypt(key, iv, ad, ciphertext, tag);
  return compressed ? await brotli.decompress(plaintext) : plaintext;
}
