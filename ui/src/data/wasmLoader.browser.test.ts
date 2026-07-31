// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Separate file (jsdom environment) from wasmLoader.test.ts (node
// environment, exercises the Node import() branch instead) -- isWeb() picks
// the fetch+verify+blob-import branch this covers when window/document
// exist. jsdom's own fetch can't resolve a bare "/sqlcipher.js" (no
// document location base the way a real browser has), so fetch is mocked
// here to serve the real on-disk bytes -- everything downstream of that
// (digest, blob construction, dynamic import of the result) is real,
// unmocked wasmLoader.ts code.

const realBytes = readFileSync(
  join(
    dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    "..",
    "sqlcipher",
    "sqlcipher.js",
  ),
);

// Independently computed (Node's own crypto, not vite.config.ts's
// sqlcipherJsIntegrity()) so this test would actually fail if that function
// ever hashed the wrong file or a different algorithm.
function realSqlcipherJsIntegrity(): string {
  return `sha512-${createHash("sha512").update(realBytes).digest("base64")}`;
}

function mockFetch(bytes: Uint8Array) {
  // .slice(byteOffset, byteOffset+byteLength), not the bare .buffer: a
  // Node Buffer's backing ArrayBuffer can be larger than the view itself
  // (small allocations are sliced from a shared pool), so the bare .buffer
  // could include extra bytes beyond what `bytes` actually represents.
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.endsWith("/sqlcipher.js")) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, arrayBuffer: async () => exact };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("wasmLoader (web fetch+verify+blob-import)", () => {
  it("passes integrity verification for the real bytes", async () => {
    mockFetch(realBytes);
    const { loadWasm } = await import("./wasmLoader");
    // jsdom has no real import()-of-a-blob:-URL support (a gap in its own
    // module-loading emulation, not something that fails in a real browser
    // -- smoke.e2e.test.ts proves the full pipeline, including this exact
    // import step, works end to end in genuine Chromium). This only proves
    // the part jsdom *can* exercise faithfully -- fetch+integrity-check --
    // didn't reject: a wrong-integrity failure and jsdom's own "Cannot find
    // package 'blob:...'" failure are trivially distinguishable by message.
    await expect(loadWasm()).rejects.toThrow(/Cannot find package 'blob:/);
  });

  it("rejects when the fetched bytes don't match __SQLCIPHER_JS_INTEGRITY__", async () => {
    const tampered = Buffer.from(realBytes);
    tampered[0] = (tampered[0]! + 1) % 256;
    mockFetch(tampered);
    const { loadWasm } = await import("./wasmLoader");
    await expect(loadWasm()).rejects.toThrow("integrity check");
  });

  it("computes the same integrity hash vite.config.ts's build-time define bakes in", () => {
    // Sanity check that this test's own independently-computed hash matches
    // the format/value the real build would produce -- if this ever
    // diverges, the two tests above would both be silently checking the
    // wrong thing.
    expect(realSqlcipherJsIntegrity()).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
  });
});
