// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// jsdom (not the default "node" environment blob.test.ts uses) specifically
// to exercise loadBrotli()'s isBrowser() branch -- the real compression
// correctness is already covered there, against the Node/require branch and
// real brotli-wasm output; this only verifies the *browser* wiring itself
// (dynamic import, the `mod.default` unwrapping brotli-wasm's browser build
// needs -- see brotli.ts's own comment) actually works, since that's the
// exact code path whose chunk-splitting caused local_index.html's
// double-mount bug (see vite.config.ts's inlineDynamicImports comment).
// brotli-wasm itself is mocked -- actually loading its real browser build
// here would try to fetch() its .wasm against jsdom's fake origin.

const compress = vi.fn((data: Uint8Array, options?: { quality: number }) => {
  expect(options?.quality).toBe(11); // BROTLI_QUALITY, see crypto/constants.ts
  return data;
});
const decompress = vi.fn((data: Uint8Array) => data);

vi.mock("brotli-wasm", () => ({
  default: Promise.resolve({ compress, decompress }),
}));

describe("brotli (browser dynamic-import wiring)", () => {
  it('compress()/decompress() work through the isBrowser() import("brotli-wasm") branch', async () => {
    const { compress: compressFn, decompress: decompressFn } = await import("./brotli");
    const payload = new TextEncoder().encode("hello brotli");

    const compressed = await compressFn(payload);
    expect(compress).toHaveBeenCalledTimes(1);
    expect(compressed).toBe(payload);

    const decompressed = await decompressFn(compressed);
    expect(decompress).toHaveBeenCalledTimes(1);
    expect(decompressed).toBe(payload);
  });
});
