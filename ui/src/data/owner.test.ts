import { beforeAll, describe, expect, it } from "vitest";

import { SqliteDb } from "./sqliteDb";
import * as owner from "./owner";

// Exercises the real SQLite wrapper against a real (small, in-memory)
// database matching docs/data_model.md's schema -- no fake client, since
// there's nothing left in this module worth faking around (no
// decrypt/unwrap pipeline anymore, just plain SQL against an already-open
// SQLCipher db).

let db: SqliteDb;

beforeAll(async () => {
  const rootKey = new Uint8Array(256).fill(9);
  db = await SqliteDb.open("/owner-test.db", { rawKey: rootKey });
  db.exec(`
    CREATE TABLE txt (id INTEGER PRIMARY KEY, txt_key BLOB NOT NULL, name TEXT NOT NULL);
    CREATE TABLE txt_parts (
      id INTEGER PRIMARY KEY,
      txt_id INTEGER NOT NULL,
      part_num INTEGER NOT NULL,
      path TEXT NOT NULL UNIQUE
    );
  `);
  db.run("INSERT INTO txt (id, txt_key, name) VALUES (1, x'00', ?);", (s) =>
    s.bindText(1, "doc-one.txt"),
  );
  db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 0, ?);", (s) =>
    s.bindText(1, "path-0"),
  );
  db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 1, ?);", (s) =>
    s.bindText(1, "path-1"),
  );
  db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 2, ?);", (s) =>
    s.bindText(1, "path-2"),
  );
});

describe("partRawPaths", () => {
  it("returns every part's path, in part_num order", () => {
    expect(owner.partRawPaths(db, 1)).toEqual(["path-0", "path-1", "path-2"]);
  });

  it("returns an empty array for a txt_id with no parts", () => {
    expect(owner.partRawPaths(db, 999)).toEqual([]);
  });
});

describe("partRawPath", () => {
  it("returns one part's path by part_num", () => {
    expect(owner.partRawPath(db, 1, 1)).toBe("path-1");
  });

  it("returns null when that part doesn't exist", () => {
    expect(owner.partRawPath(db, 1, 99)).toBeNull();
  });
});

describe("partCount", () => {
  it("counts this document's parts", () => {
    expect(owner.partCount(db, 1)).toBe(3);
  });

  it("returns 0 for a txt_id with no parts", () => {
    expect(owner.partCount(db, 999)).toBe(0);
  });
});
