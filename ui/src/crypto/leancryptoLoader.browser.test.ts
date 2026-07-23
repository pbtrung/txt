// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

// Separate file (jsdom environment) from leancryptoLoader.test.ts (node
// environment, exercises the Node/require branch instead) -- isBrowser()
// only picks the <script src="/leancrypto.js"> branch this covers when
// window/document actually exist.

afterEach(() => {
  delete (window as unknown as { leancrypto?: unknown }).leancrypto;
  document.head.querySelectorAll("script").forEach((el) => el.remove());
});

describe("leancryptoLoader (browser script tag)", () => {
  it("sets integrity and crossOrigin on the leancrypto.js <script> before it can fetch", async () => {
    const { getLeancrypto } = await import("./leancryptoLoader");
    const pending = getLeancrypto();

    // Script creation/configuration happens synchronously inside the
    // Promise executor, before the (async) load ever resolves -- so this is
    // already there to inspect without waiting on anything.
    const script = document.head.querySelector<HTMLScriptElement>('script[src$="/leancrypto.js"]');
    expect(script).not.toBeNull();
    expect(script!.integrity).toMatch(/^sha512-/);
    expect(script!.crossOrigin).toBe("anonymous");

    // Let the pending load settle instead of leaving it dangling -- getLeancrypto()
    // dereferences a few GOT-style globals off whatever module the script
    // "loaded" provides, so this needs just enough of a fake module to
    // satisfy that, not real leancrypto output.
    (window as unknown as { leancrypto: () => Promise<unknown> }).leancrypto = () =>
      Promise.resolve({
        HEAPU32: new Uint32Array(16),
        _lc_sha3_512: 0,
        _lc_sha3_256: 4,
        _lc_seeded_rng: 8,
      });
    script!.onload?.(new Event("load"));
    await pending;
  });
});
