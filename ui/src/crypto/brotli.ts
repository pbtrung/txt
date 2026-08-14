// txt/crypto_blob.py's encrypt_json/decrypt_json brotli-compress the JSON
// payload before it ever reaches CryptoBlob's own AEAD layer, so any AA
// value stored via encrypt_json (cred_store.content, in practice) needs the
// same step to decode. Browsers and Node reach compression differently: the
// Web Streams-based Compression/DecompressionStream API in the browser,
// node:zlib's synchronous brotli functions under Vitest/Node.
import { isBrowser } from "../env";

// "br" is a real, widely-supported CompressionFormat value; this repo's
// current TS DOM lib just doesn't list it yet.
const BROTLI = "br" as CompressionFormat;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function nodeZlib() {
  // @ts-expect-error node:zlib has no ambient types under ui/'s browser-scoped
  // tsconfig; this path only ever runs under Node/Vitest (see isBrowser()).
  // @vite-ignore: keep Vite's client bundler from resolving this into the browser build.
  return import(/* @vite-ignore */ "node:zlib");
}

export async function brotliCompress(data: Uint8Array): Promise<Uint8Array> {
  if (isBrowser()) {
    const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream(BROTLI));
    return readAll(stream);
  }
  const zlib = await nodeZlib();
  return new Uint8Array(zlib.brotliCompressSync(data));
}

export async function brotliDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (isBrowser()) {
    const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream(BROTLI));
    return readAll(stream);
  }
  const zlib = await nodeZlib();
  return new Uint8Array(zlib.brotliDecompressSync(data));
}
