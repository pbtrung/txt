// Thin wrapper around the brotli-wasm package, mirroring how txt/crypto.py's
// Blob uses Python's `brotli` module: compress before encrypting a structured
// (JSON) payload, decompress after decrypting one. Brotli is a deterministic
// public format (RFC 7932), so any conformant decoder reads any conformant
// encoder's output -- blobs compressed here stay readable by the Python CLI
// and vice versa, no version negotiation needed.
//
// brotli-wasm ships a browser build (fetches its .wasm via a URL Vite
// rewrites at bundle time -- the officially documented usage) and a Node
// build (loads its .wasm synchronously via fs, no fetch). Which one a given
// `import`/`require` resolves to is decided by which package.json "exports"
// condition is active, and dynamic `import()` *always* signals the "import"
// condition (picking the browser build) regardless of runtime -- there's no
// way to reach the Node build through `import()`. So, like
// leancryptoLoader.ts, this branches explicitly: real browsers use the
// dynamic-import browser build; Node (Vitest) uses `require()` via
// `createRequire`, the only way to actually trigger the "require" condition
// and get the synchronous, fetch-free Node build.

import { BROTLI_QUALITY } from "./constants";

interface BrotliApi {
  compress(data: Uint8Array, options?: { quality: number }): Uint8Array;
  decompress(data: Uint8Array): Uint8Array;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

async function loadBrotli(): Promise<BrotliApi> {
  if (isBrowser()) {
    // The browser build's default export is itself a Promise (see
    // node_modules/brotli-wasm/index.d.ts) -- await it, not just the
    // dynamic import().
    const mod = await import(/* @vite-ignore */ "brotli-wasm");
    return (await (mod.default ?? mod)) as BrotliApi;
  }
  // The Node build's export is the API object directly, synchronously.
  const { createRequire } = await import(/* @vite-ignore */ "node:module");
  const require = createRequire(import.meta.url);
  return require("brotli-wasm") as BrotliApi;
}

let brotliPromise: Promise<BrotliApi> | null = null;

function getBrotli(): Promise<BrotliApi> {
  if (!brotliPromise) {
    brotliPromise = loadBrotli();
  }
  return brotliPromise;
}

export async function compress(payload: Uint8Array): Promise<Uint8Array> {
  const b = await getBrotli();
  return b.compress(payload, { quality: BROTLI_QUALITY });
}

export async function decompress(payload: Uint8Array): Promise<Uint8Array> {
  const b = await getBrotli();
  return b.decompress(payload);
}
