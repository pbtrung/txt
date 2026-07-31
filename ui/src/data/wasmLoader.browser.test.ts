// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Separate file (jsdom environment) from wasmLoader.test.ts (node
// environment, exercises the Node/import() branch instead) -- isBrowser()
// only picks the <script src="/sqlcipher.js"> branch this covers when
// window/document actually exist.

// Independently computed (Node's own crypto, not vite.config.ts's
// sqlcipherJsIntegrity()) so this test would actually fail if that function
// ever hashed the wrong file or a different algorithm -- checking only the
// "sha512-" shape wouldn't catch that.
function realSqlcipherJsIntegrity(): string {
  const uiDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const bytes = readFileSync(join(uiDir, "..", "sqlcipher", "sqlcipher.js"));
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

afterEach(() => {
  delete (window as unknown as { Sqlite3Wasm?: unknown }).Sqlite3Wasm;
  document.head.querySelectorAll("script").forEach((el) => el.remove());
});

describe("wasmLoader (browser script tag)", () => {
  it("sets integrity and crossOrigin on the sqlcipher.js <script> before it can fetch", async () => {
    const { loadWasm } = await import("./wasmLoader");
    const pending = loadWasm();

    // Script creation/configuration happens synchronously inside the
    // Promise executor, before the (async) load ever resolves -- so this is
    // already there to inspect without waiting on anything.
    const script = document.head.querySelector<HTMLScriptElement>('script[src$="/sqlcipher.js"]');
    expect(script).not.toBeNull();
    expect(script!.integrity).toBe(realSqlcipherJsIntegrity());
    expect(script!.crossOrigin).toBe("anonymous");

    // Let the pending load settle instead of leaving it dangling --
    // loadWasm() just needs the factory to resolve to something.
    (window as unknown as { Sqlite3Wasm: () => Promise<unknown> }).Sqlite3Wasm = () =>
      Promise.resolve({});
    script!.onload?.(new Event("load"));
    await pending;
  });
});
