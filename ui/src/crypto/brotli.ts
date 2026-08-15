// txt/crypto_blob.py's encrypt_json/decrypt_json brotli-compress the JSON
// payload before it ever reaches CryptoBlob's own AEAD layer, so any wrapped
// JSON value (cred_store.content, txt.metadata) needs the same step to
// decode. brotli-wasm gives one WASM implementation shared by both the
// browser and Node/Vitest -- CompressionStream's own "br" support isn't
// available in every browser this app needs to run in, and Node's zlib
// would otherwise be a second, separate implementation to keep in sync.
import brotliWasm from "brotli-wasm";

export async function brotliCompress(data: Uint8Array): Promise<Uint8Array> {
  const brotli = await brotliWasm;
  return brotli.compress(data);
}

export async function brotliDecompress(data: Uint8Array): Promise<Uint8Array> {
  const brotli = await brotliWasm;
  return brotli.decompress(data);
}
