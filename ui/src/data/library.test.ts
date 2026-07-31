import { beforeEach, describe, expect, it } from "vitest";

import { SqliteDb } from "./sqliteDb";
import * as brotli from "../crypto/brotli";
import { loadLibrary } from "./library";

let db: SqliteDb;
let dbCounter = 0;

beforeEach(async () => {
  const rootKey = new Uint8Array(256).fill(9);
  db = await SqliteDb.open(`/library-test-${dbCounter++}.db`, { rawKey: rootKey });
  db.exec(`
    CREATE TABLE txt (
      id            INTEGER PRIMARY KEY,
      name          TEXT NOT NULL,
      metadata      BLOB,
      last_part_num INTEGER,
      last_accessed INTEGER
    );
  `);
});

describe("loadLibrary", () => {
  it("builds metadataById from name and decompressed metadata, defaulting title to name when absent", async () => {
    const opfJson = JSON.stringify({
      title: { text: "Real Title" },
      creator: { text: "Some Author" },
    });
    const compressed = await brotli.compress(new TextEncoder().encode(opfJson));
    db.run("INSERT INTO txt (id, name, metadata) VALUES (1, ?, ?);", (s) => {
      s.bindText(1, "doc-one.txt");
      s.bindBlob(2, compressed);
    });
    db.run("INSERT INTO txt (id, name, metadata) VALUES (2, ?, NULL);", (s) =>
      s.bindText(1, "doc-two.txt"),
    );

    const { metadataById } = await loadLibrary(db);
    expect(metadataById.get(1)?.title).toBe("Real Title");
    expect(metadataById.get(1)?.author).toBe("Some Author");
    expect(metadataById.get(2)?.title).toBe("doc-two.txt"); // no metadata -> falls back to name
  });

  it("builds accessMap only for documents that have been opened", async () => {
    db.run("INSERT INTO txt (id, name, last_part_num, last_accessed) VALUES (1, 'a', 3, 5000);");
    db.run("INSERT INTO txt (id, name) VALUES (2, 'b');");

    const { accessMap } = await loadLibrary(db);
    expect(accessMap.get(1)).toEqual({ lastPartNum: 3, lastAccessedMs: 5000 });
    expect(accessMap.has(2)).toBe(false);
  });
});
