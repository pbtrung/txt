// lc_kyber_1024_x448 composite keypair, Encapsulate, and Decapsulate
// (docs/crypto.md). Mirrors txt/crypto.py's Kem class.

import * as c from "./constants";
import { concatBytes, randomBytes } from "./bytes";
import * as blob from "./blob";
import { kemDecapsulate, kemEncapsulate, kemKeypair } from "./leancryptoLoader";

export interface Keypair {
  pk: Uint8Array;
  sk: Uint8Array;
}

export async function keypair(): Promise<Keypair> {
  return kemKeypair(c.KEM_PK_LEN, c.KEM_SK_LEN);
}

export interface Encapsulation {
  ct: Uint8Array;
  ss: Uint8Array;
}

/** Raw (non-KDF) encapsulation: ss is Kyber-SS || X448-SS, uncombined.
 *
 * Combining happens in Blob.encrypt's own HKDF-SHA3-512 (see crypto.md), not
 * inside leancrypto -- deliberately not using lc_kyber_1024_x448_enc_kdf,
 * which would run its own separate KMAC256-based combiner instead.
 */
export async function encapsulate(pubKey: Uint8Array): Promise<Encapsulation> {
  return kemEncapsulate(pubKey, c.KEM_CT_LEN, c.KEM_SS_LEN);
}

export async function decapsulate(privKey: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  return kemDecapsulate(privKey, ct, c.KEM_SS_LEN);
}

export interface Wrapped {
  saltKemCt: Uint8Array;
  blob: Uint8Array;
}

/** Encapsulate procedure (crypto.md): wraps payload for pubKey's owner.
 *
 * Returns { saltKemCt, blob } -- e.g. txt_shares.salt_kem_ct/txt_key.
 */
export async function wrap(pubKey: Uint8Array, payload: Uint8Array): Promise<Wrapped> {
  const salt = randomBytes(c.SALT_LEN);
  const { ct, ss } = await encapsulate(pubKey);
  const wrappedBlob = await blob.encrypt(ss, payload, { salt });
  return { saltKemCt: concatBytes(salt, ct), blob: wrappedBlob };
}

/** Decapsulate procedure (crypto.md): recovers payload wrapped by wrap(). */
export async function unwrap(privKey: Uint8Array, saltKemCt: Uint8Array, wrappedBlob: Uint8Array): Promise<Uint8Array> {
  const ct = saltKemCt.slice(c.SALT_LEN);
  const ss = await decapsulate(privKey, ct);
  return blob.decrypt(ss, wrappedBlob);
}
