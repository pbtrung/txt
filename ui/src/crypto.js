import { hkdf } from '@noble/hashes/hkdf.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import sodium from 'libsodium-wrappers';
import brotliPromise from 'brotli-wasm';

let brotli = null;

export async function initCrypto() {
  await sodium.ready;
  brotli = await brotliPromise;
}

// Mirrors Python _derive(): 56 bytes → key (32) + nonce (24)
function derivePart(masterKey, salt) {
  const km = hkdf(sha3_256, masterKey, salt, new Uint8Array(0), 56);
  return { key: km.slice(0, 32), nonce: km.slice(32) };
}

// Mirrors Python _derive_name(): 88 bytes → key (32) + nonce (24) + hmac_key (32)
function deriveName(masterKey, salt) {
  const km = hkdf(sha3_256, masterKey, salt, new Uint8Array(0), 88);
  return { key: km.slice(0, 32), nonce: km.slice(32, 56) };
}

export function decryptName(blob, masterKey) {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const { key, nonce } = deriveName(masterKey, b.slice(0, 32));
  const nameBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, b.slice(32), null, nonce, key,
  );
  return new TextDecoder().decode(nameBytes);
}

export function decryptPart(blob, masterKey) {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const { key, nonce } = derivePart(masterKey, b.slice(0, 32));
  const compressed = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, b.slice(32), null, nonce, key,
  );
  return new TextDecoder().decode(brotli.decompress(compressed));
}

export function parseMasterKey(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
