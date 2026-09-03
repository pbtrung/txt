// Ports txt/crypto_blob.py's blob format exactly (docs/crypto.md's
// Encrypt/Decrypt blob format): magic(2)||version(2)||salt(64)||
// ciphertext||tag(64), AD = magic||version||salt. The format has no
// caller-supplied context, so HKDF's info is always empty.
import { aeadDecrypt, aeadEncrypt, hkdfSha3_512 } from "./aead";
import { brotliCompress, brotliDecompress } from "./brotli";

const MAGIC = new Uint8Array([0x54, 0x58]);
const VERSION = new Uint8Array([0x01, 0x00]);
const MIN_BLOB_LEN = 132;
const SALT_LEN = 64;
const INFO = new Uint8Array(0);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function derive(
  ikm: Uint8Array,
  salt: Uint8Array,
): Promise<{ key: Uint8Array; iv: Uint8Array }> {
  const okm = await hkdfSha3_512(ikm, salt, INFO, 128);
  return { key: okm.slice(0, 64), iv: okm.slice(64) };
}

export async function encrypt(
  plaintext: Uint8Array,
  ikm: Uint8Array,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const { key, iv } = await derive(ikm, salt);
  const ad = concat(MAGIC, VERSION, salt);
  const { ciphertext, tag } = await aeadEncrypt(key, iv, ad, plaintext);
  return concat(MAGIC, VERSION, salt, ciphertext, tag);
}

function parseHeader(blob: Uint8Array): {
  salt: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
} {
  if (blob.length < MIN_BLOB_LEN) {
    throw new Error(`blob too short: ${blob.length} < ${MIN_BLOB_LEN}`);
  }
  if (blob[0] !== MAGIC[0] || blob[1] !== MAGIC[1]) {
    throw new Error("bad magic");
  }
  if (blob[2] !== VERSION[0]) {
    throw new Error(`unsupported major version: ${blob[2]}`);
  }
  return {
    salt: blob.slice(4, 68),
    ciphertext: blob.slice(68, blob.length - 64),
    tag: blob.slice(blob.length - 64),
  };
}

export async function decrypt(blob: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const { salt, ciphertext, tag } = parseHeader(blob);
  const { key, iv } = await derive(ikm, salt);
  const ad = concat(MAGIC, VERSION, salt);
  return aeadDecrypt(key, iv, ad, ciphertext, tag);
}

export async function encryptJson(
  payload: unknown,
  ikm: Uint8Array,
): Promise<Uint8Array> {
  const compressed = await brotliCompress(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return encrypt(compressed, ikm);
}

export async function decryptJson<T = unknown>(
  blob: Uint8Array,
  ikm: Uint8Array,
): Promise<T> {
  const decompressed = await brotliDecompress(await decrypt(blob, ikm));
  return JSON.parse(new TextDecoder().decode(decompressed)) as T;
}
