import { describe, expect, it } from "vitest";
import { brotliCompress } from "../crypto/brotli";
import { toBase32Crockford } from "../util/base32Crockford";
import { openBB, type BBEngine } from "./bbEngine";
import { readDocument } from "./document";

async function createSchema(bb: BBEngine): Promise<void> {
  bb.execute("CREATE TABLE txt (id INTEGER PRIMARY KEY AUTOINCREMENT, txt_key BLOB NOT NULL, prefix BLOB NOT NULL, name TEXT NOT NULL, n_parts INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  bb.execute("CREATE TABLE txt_meta (txt_id INTEGER PRIMARY KEY, metadata BLOB NOT NULL)");
  bb.execute("CREATE TABLE txt_parts (txt_id INTEGER NOT NULL, part_num INTEGER NOT NULL, path BLOB NOT NULL, PRIMARY KEY (txt_id, part_num))");
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

describe("readDocument (real BB)", () => {
  it("returns null when the document doesn't exist", async () => {
    const bb = await openBB(randomBytes(256), new Map());
    await createSchema(bb);

    expect(await readDocument(bb, 999)).toBeNull();
    bb.close();
  });

  it("reads txt, decodes prefix/path to base32-Crockford, and orders parts", async () => {
    const bb = await openBB(randomBytes(256), new Map());
    await createSchema(bb);

    const txtKey = randomBytes(128);
    const prefix = randomBytes(32);
    const path2 = randomBytes(32);
    const path1 = randomBytes(32);

    bb.execute("INSERT INTO txt (txt_key, prefix, name, n_parts, created_at) VALUES (?, ?, ?, ?, ?)", [txtKey, prefix, "book.epub", 2, 1000]);
    bb.execute("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 2, ?)", [path2]);
    bb.execute("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 1, ?)", [path1]);

    const doc = await readDocument(bb, 1);
    bb.close();

    expect(doc?.name).toBe("book.epub");
    expect(doc?.nParts).toBe(2);
    expect([...doc!.txtKey]).toEqual([...txtKey]);
    expect(doc?.prefix).toBe(toBase32Crockford(prefix));
    expect(doc?.parts).toEqual([
      { partNum: 1, path: toBase32Crockford(path1) },
      { partNum: 2, path: toBase32Crockford(path2) },
    ]);
  });

  it("decodes brotli(JSON) metadata when a txt_meta row exists", async () => {
    const bb = await openBB(randomBytes(256), new Map());
    await createSchema(bb);
    bb.execute("INSERT INTO txt (txt_key, prefix, name, n_parts, created_at) VALUES (?, ?, ?, ?, ?)", [randomBytes(128), randomBytes(32), "book.epub", 1, 1000]);
    const metadata = await brotliCompress(new TextEncoder().encode(JSON.stringify({ title: "Dune" })));
    bb.execute("INSERT INTO txt_meta (txt_id, metadata) VALUES (1, ?)", [metadata]);

    const doc = await readDocument(bb, 1);
    bb.close();

    expect(doc?.metadata).toEqual({ title: "Dune" });
  });

  it("returns null metadata when there is no txt_meta row (no OPF sidecar)", async () => {
    const bb = await openBB(randomBytes(256), new Map());
    await createSchema(bb);
    bb.execute("INSERT INTO txt (txt_key, prefix, name, n_parts, created_at) VALUES (?, ?, ?, ?, ?)", [randomBytes(128), randomBytes(32), "book.epub", 1, 1000]);

    const doc = await readDocument(bb, 1);
    bb.close();

    expect(doc?.metadata).toBeNull();
  });
});
