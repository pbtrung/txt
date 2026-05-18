import createLeancrypto from '../leancrypto/leancrypto.js';
import wasmUrl from '../leancrypto/leancrypto.wasm?url';
import brotliPromise from 'brotli-wasm';

const SALT_LEN = 64;
const TAG_LEN = 64;
const KEY_LEN = 64;
const IV_LEN = 64;
const MASTER_KEY_LEN = 128;
const MAX_DECOMPRESSED_LEN = 1024 * 1024;
const DECOMPRESS_CHUNK_LEN = 64 * 1024;

let lc = null;
let brotli = null;

export async function initCrypto() {
  [lc, brotli] = await Promise.all([
    createLeancrypto({ locateFile: () => wasmUrl }),
    brotliPromise,
  ]);
}

export function zeroBytes(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

function alloc(data) {
  const ptr = lc._malloc(data.length);
  lc.HEAPU8.set(data, ptr);
  return ptr;
}

function freeAll(...ptrs) {
  for (const ptr of ptrs) lc._free(ptr);
}

function sha3_512ptr() {
  return lc.HEAP32[lc._lc_sha3_512 >> 2];
}

function makeHkdfPointers(ikm, salt, length) {
  return {
    ikmPtr: alloc(ikm),
    saltPtr: alloc(salt),
    outPtr: lc._malloc(length),
  };
}

function runHkdf(p, ikm, salt, length) {
  const ret = lc._lc_hkdf(
    sha3_512ptr(), p.ikmPtr, ikm.length, p.saltPtr, salt.length,
    0, 0, p.outPtr, length,
  );
  if (ret !== 0) throw new Error(`lc_hkdf failed: ${ret}`);
  return lc.HEAPU8.slice(p.outPtr, p.outPtr + length);
}

function _hkdf(ikm, salt, length) {
  const p = makeHkdfPointers(ikm, salt, length);
  try { return runHkdf(p, ikm, salt, length); }
  finally { freeAll(p.ikmPtr, p.saltPtr, p.outPtr); }
}

function setAeadKey(ctx, key, iv) {
  const keyPtr = alloc(key);
  const ivPtr = alloc(iv);
  const ret = lc._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
  freeAll(keyPtr, ivPtr);
  if (ret !== 0) throw new Error('lc_aead_setkey failed');
}

function makeEncryptPointers(pt, aad) {
  return {
    ptPtr: alloc(pt),
    ctPtr: lc._malloc(pt.length),
    aadPtr: alloc(aad),
    tagPtr: lc._malloc(TAG_LEN),
  };
}

function joinCtTag(ctBytes, tagBytes) {
  const out = new Uint8Array(ctBytes.length + TAG_LEN);
  out.set(ctBytes);
  out.set(tagBytes, ctBytes.length);
  return out;
}

function encryptWithPointers(ctx, p, pt, aad) {
  const ret = lc._lc_aead_encrypt(
    ctx, p.ptPtr, p.ctPtr, pt.length, p.aadPtr, aad.length, p.tagPtr, TAG_LEN,
  );
  if (ret !== 0) throw new Error('lc_aead_encrypt failed');
  const ctBytes = lc.HEAPU8.slice(p.ctPtr, p.ctPtr + pt.length);
  const tagBytes = lc.HEAPU8.slice(p.tagPtr, p.tagPtr + TAG_LEN);
  return joinCtTag(ctBytes, tagBytes);
}

function _aeadDoEncrypt(ctx, key, iv, pt, aad) {
  setAeadKey(ctx, key, iv);
  const p = makeEncryptPointers(pt, aad);
  try { return encryptWithPointers(ctx, p, pt, aad); }
  finally { freeAll(p.ptPtr, p.ctPtr, p.aadPtr, p.tagPtr); }
}

function makeDecryptPointers(ct, tag, aad) {
  return {
    ctPtr: alloc(ct),
    ptPtr: lc._malloc(ct.length),
    aadPtr: alloc(aad),
    tagPtr: alloc(tag),
  };
}

function splitCtTag(ctTag) {
  return {
    ct: ctTag.slice(0, -TAG_LEN),
    tag: ctTag.slice(-TAG_LEN),
  };
}

function decryptWithPointers(ctx, p, ct, aad) {
  const ret = lc._lc_aead_decrypt(
    ctx, p.ctPtr, p.ptPtr, ct.length, p.aadPtr, aad.length, p.tagPtr, TAG_LEN,
  );
  if (ret !== 0) throw new Error('AEAD tag verification failed');
  return lc.HEAPU8.slice(p.ptPtr, p.ptPtr + ct.length);
}

function _aeadDoDecrypt(ctx, key, iv, ctTag, aad) {
  setAeadKey(ctx, key, iv);
  const { ct, tag } = splitCtTag(ctTag);
  const p = makeDecryptPointers(ct, tag, aad);
  try { return decryptWithPointers(ctx, p, ct, aad); }
  finally { freeAll(p.ctPtr, p.ptPtr, p.aadPtr, p.tagPtr); }
}

function allocAeadContext(ctxSlot) {
  const ret = lc._lc_ak_alloc_taglen(sha3_512ptr(), TAG_LEN, ctxSlot);
  if (ret !== 0) throw new Error('lc_ak_alloc_taglen failed');
  return lc.HEAP32[ctxSlot >> 2];
}

function withAeadContext(fn) {
  const ctxSlot = lc._malloc(4);
  let ctx = 0;
  try {
    ctx = allocAeadContext(ctxSlot);
    return fn(ctx);
  } finally {
    if (ctx) lc._lc_aead_zero_free(ctx);
    lc._free(ctxSlot);
  }
}

function _aeadEncrypt(key, iv, pt, aad) {
  return withAeadContext(ctx => _aeadDoEncrypt(ctx, key, iv, pt, aad));
}

function _aeadDecrypt(key, iv, ctTag, aad) {
  return withAeadContext(ctx => _aeadDoDecrypt(ctx, key, iv, ctTag, aad));
}

function _derivePart(masterKey, salt) {
  const km = _hkdf(masterKey, salt, KEY_LEN + IV_LEN);
  return { key: km.slice(0, KEY_LEN), iv: km.slice(KEY_LEN) };
}

function _deriveName(masterKey, salt) {
  const km = _hkdf(masterKey, salt, KEY_LEN + IV_LEN);
  return { key: km.slice(0, KEY_LEN), iv: km.slice(KEY_LEN) };
}

function newDecompressState() {
  return {
    stream: new brotli.DecompressStream(),
    codes: brotli.BrotliStreamResultCode,
    chunks: [], total: 0, inputOffset: 0, resultCode: null,
  };
}

function appendDecompressChunk(state, chunk) {
  if (chunk.length === 0) return;
  state.chunks.push(chunk);
  state.total += chunk.length;
  if (state.total > MAX_DECOMPRESSED_LEN)
    throw new Error('Decompressed payload exceeds 1MB limit');
}

function takeDecompressChunk(state, compressed) {
  const remaining = MAX_DECOMPRESSED_LEN + 1 - state.total;
  const outputSize = Math.min(DECOMPRESS_CHUNK_LEN, remaining);
  const input = compressed.subarray(state.inputOffset);
  const result = state.stream.decompress(input, outputSize);
  try {
    appendDecompressChunk(state, result.buf);
    state.resultCode = result.code;
    state.inputOffset += result.input_offset;
  } finally {
    result.free();
  }
}

function decompressLoop(state, compressed) {
  do {
    takeDecompressChunk(state, compressed);
  } while (state.resultCode === state.codes.NeedsMoreOutput);
}

function assertDecompressDone(state, compressed) {
  const ok = state.resultCode === state.codes.ResultSuccess;
  if (!ok || state.inputOffset !== compressed.length)
    throw new Error('Brotli decompression failed');
}

function joinChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function _decompressLimited(compressed) {
  const state = newDecompressState();
  try { decompressLoop(state, compressed); }
  finally { state.stream.free(); }
  assertDecompressDone(state, compressed);
  return joinChunks(state.chunks, state.total);
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
  return new TextDecoder().decode(_decompressLimited(compressed));
}

export function encryptBookmark(obj, masterKey) {
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const compressed = brotli.compress(plain);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const { key, iv } = _derivePart(masterKey, salt);
  const ctTag = _aeadEncrypt(key, iv, compressed, salt);
  const out = new Uint8Array(SALT_LEN + ctTag.length);
  out.set(salt);
  out.set(ctTag, SALT_LEN);
  return out;
}

export function decryptBookmark(blob, masterKey) {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const salt = b.slice(0, SALT_LEN);
  const { key, iv } = _derivePart(masterKey, salt);
  const compressed = _aeadDecrypt(key, iv, b.slice(SALT_LEN), salt);
  return JSON.parse(new TextDecoder().decode(_decompressLimited(compressed)));
}

function decodeBase64Key(b64) {
  if (typeof b64 !== 'string')
    throw new Error('master_key must be a base64 string');
  try {
    return Uint8Array.from(atob(b64.trim()), c => c.charCodeAt(0));
  } catch {
    throw new Error('master_key must be valid base64');
  }
}

function assertMasterKeyLength(key) {
  if (key.length === MASTER_KEY_LEN) return;
  zeroBytes(key);
  throw new Error(`master_key must decode to ${MASTER_KEY_LEN} bytes`);
}

export function parseMasterKey(b64) {
  const key = decodeBase64Key(b64);
  assertMasterKeyLength(key);
  return key;
}
