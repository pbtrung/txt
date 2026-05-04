import createLeancrypto from '../leancrypto/leancrypto.js';
import wasmUrl from '../leancrypto/leancrypto.wasm?url';
import brotliPromise from 'brotli-wasm';

const SALT_LEN = 64;
const TAG_LEN = 64;
const KEY_LEN = 64;
const IV_LEN = 64;
const HMAC_LEN = 32;

let lc = null;
let brotli = null;

export async function initCrypto() {
  [lc, brotli] = await Promise.all([
    createLeancrypto({ locateFile: () => wasmUrl }),
    brotliPromise,
  ]);
}

function alloc(data) {
  const ptr = lc._malloc(data.length);
  lc.HEAPU8.set(data, ptr);
  return ptr;
}

function sha3_512ptr() {
  return lc.HEAP32[lc._lc_sha3_512 >> 2];
}

function sha3_256ptr() {
  return lc.HEAP32[lc._lc_sha3_256 >> 2];
}

function _hkdf(ikm, salt, length) {
  const ikmPtr = alloc(ikm);
  const saltPtr = alloc(salt);
  const outPtr = lc._malloc(length);
  try {
    const ret = lc._lc_hkdf(
      sha3_512ptr(), ikmPtr, ikm.length, saltPtr, salt.length, 0, 0, outPtr, length,
    );
    if (ret !== 0) throw new Error(`lc_hkdf failed: ${ret}`);
    return lc.HEAPU8.slice(outPtr, outPtr + length);
  } finally {
    lc._free(ikmPtr);
    lc._free(saltPtr);
    lc._free(outPtr);
  }
}

function _hmac(key, data) {
  const keyPtr = alloc(key);
  const dataPtr = alloc(data);
  const macPtr = lc._malloc(HMAC_LEN);
  try {
    const ret = lc._lc_hmac(
      sha3_256ptr(), keyPtr, key.length, dataPtr, data.length, macPtr,
    );
    if (ret !== 0) throw new Error(`lc_hmac failed: ${ret}`);
    return lc.HEAPU8.slice(macPtr, macPtr + HMAC_LEN);
  } finally {
    lc._free(keyPtr);
    lc._free(dataPtr);
    lc._free(macPtr);
  }
}

function _aeadDecrypt(key, iv, ctTag, aad) {
  const ctxSlot = lc._malloc(4);
  let ctx = 0;
  try {
    if (lc._lc_ak_alloc_taglen(sha3_512ptr(), TAG_LEN, ctxSlot) !== 0)
      throw new Error('lc_ak_alloc_taglen failed');
    ctx = lc.HEAP32[ctxSlot >> 2];

    const keyPtr = alloc(key);
    const ivPtr = alloc(iv);
    const r = lc._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
    lc._free(keyPtr);
    lc._free(ivPtr);
    if (r !== 0) throw new Error('lc_aead_setkey failed');

    const ct = ctTag.slice(0, -TAG_LEN);
    const tag = ctTag.slice(-TAG_LEN);
    const ctPtr = alloc(ct);
    const ptPtr = lc._malloc(ct.length);
    const aadPtr = alloc(aad);
    const tagPtr = alloc(tag);
    const dec = lc._lc_aead_decrypt(
      ctx, ctPtr, ptPtr, ct.length, aadPtr, aad.length, tagPtr, TAG_LEN,
    );
    const out = lc.HEAPU8.slice(ptPtr, ptPtr + ct.length);
    lc._free(ctPtr);
    lc._free(ptPtr);
    lc._free(aadPtr);
    lc._free(tagPtr);
    if (dec !== 0) throw new Error('AEAD tag verification failed');
    return out;
  } finally {
    if (ctx) lc._lc_aead_zero_free(ctx);
    lc._free(ctxSlot);
  }
}

function _derivePart(masterKey, salt) {
  const km = _hkdf(masterKey, salt, KEY_LEN + IV_LEN);
  return { key: km.slice(0, KEY_LEN), iv: km.slice(KEY_LEN) };
}

function _deriveName(masterKey, salt) {
  const km = _hkdf(masterKey, salt, KEY_LEN + IV_LEN + HMAC_LEN);
  return { key: km.slice(0, KEY_LEN), iv: km.slice(KEY_LEN, KEY_LEN + IV_LEN) };
}

export function decryptName(blob, masterKey) {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const salt = b.slice(0, SALT_LEN);
  const { key, iv } = _deriveName(masterKey, salt);
  return new TextDecoder().decode(_aeadDecrypt(key, iv, b.slice(SALT_LEN), salt));
}

export function decryptPart(blob, masterKey) {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const salt = b.slice(0, SALT_LEN);
  const { key, iv } = _derivePart(masterKey, salt);
  const compressed = _aeadDecrypt(key, iv, b.slice(SALT_LEN), salt);
  return new TextDecoder().decode(brotli.decompress(compressed));
}

export function parseMasterKey(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

