import { describe, expect, it } from "vitest";
import { openBB } from "./bbEngine";

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(256));
}

describe("openBB (real sqlcipher.wasm + jsVfs)", () => {
  it("creates a fresh BB, writes rows, and reopens from just the drained pages", async () => {
    const key = randomKey();

    const bb = await openBB(key, new Map());
    bb.execute("CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)");
    bb.execute("INSERT INTO t (a, b) VALUES (?, ?)", [1, "hello"]);
    bb.execute("INSERT INTO t (a, b) VALUES (?, ?)", [2, "world"]);
    const pages = bb.drainDirtyPages();
    bb.close();

    expect(pages.size).toBeGreaterThan(0);
    expect(pages.has(1)).toBe(true);

    const reopened = await openBB(key, pages);
    const rows = reopened.query("SELECT a, b FROM t ORDER BY a");
    reopened.close();

    expect(rows).toEqual([
      [1, "hello"],
      [2, "world"],
    ]);
  });

  it("rejects the wrong key on reopen", async () => {
    const key = randomKey();
    const bb = await openBB(key, new Map());
    bb.execute("CREATE TABLE t(a)");
    bb.execute("INSERT INTO t VALUES (1)");
    const pages = bb.drainDirtyPages();
    bb.close();

    // The wrong key fails as soon as openBB tries to read page 1 while
    // setting its own pragmas -- SQLCipher validates the key lazily, on
    // first real page access, not at sqlite3_key() itself.
    await expect(openBB(randomKey(), pages)).rejects.toThrow();
  });

  it("drainDirtyPages only returns pages written since the last drain", async () => {
    const key = randomKey();
    const bb = await openBB(key, new Map());
    bb.execute("CREATE TABLE t(a)");
    bb.drainDirtyPages();

    bb.execute("INSERT INTO t VALUES (1)");
    const secondDrain = bb.drainDirtyPages();
    expect(secondDrain.size).toBeGreaterThan(0);

    expect(bb.drainDirtyPages().size).toBe(0);
    bb.close();
  });

  it("binds params through to query results, including blobs", async () => {
    const key = randomKey();
    const bb = await openBB(key, new Map());
    bb.execute("CREATE TABLE t(a BLOB)");
    bb.execute("INSERT INTO t VALUES (?)", [new Uint8Array([1, 2, 3])]);

    const rows = bb.query("SELECT a FROM t");
    bb.close();

    expect([...(rows[0][0] as Uint8Array)]).toEqual([1, 2, 3]);
  });
});
