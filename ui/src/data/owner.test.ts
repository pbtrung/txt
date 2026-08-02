import { beforeAll, describe, expect, it } from "vitest";

import { SqliteDb } from "./sqliteDb";
import * as owner from "./owner";

// Exercises the real SQLite wrapper against a real (small, in-memory)
// database matching docs/data_model.md's schema -- no fake client, since
// there's nothing left in this module worth faking around (no
// decrypt/unwrap pipeline anymore, just plain SQL against an already-open
// SQLCipher db).

let db: SqliteDb;

function content(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

beforeAll(async () => {
  const rootKey = new Uint8Array(256).fill(9);
  db = await SqliteDb.open("/owner-test.db", { rawKey: rootKey });
  db.exec(`
    CREATE TABLE txt (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE txt_parts (
      id INTEGER PRIMARY KEY,
      txt_id INTEGER NOT NULL,
      part_num INTEGER NOT NULL,
      content BLOB NOT NULL UNIQUE
    );
  `);
  db.run("INSERT INTO txt (id, name) VALUES (1, ?);", (s) =>
    s.bindText(1, "doc-one.txt"),
  );
  db.run(
    "INSERT INTO txt_parts (txt_id, part_num, content) VALUES (1, 0, ?);",
    (s) => s.bindBlob(1, content("part-0")),
  );
  db.run(
    "INSERT INTO txt_parts (txt_id, part_num, content) VALUES (1, 1, ?);",
    (s) => s.bindBlob(1, content("part-1")),
  );
  db.run(
    "INSERT INTO txt_parts (txt_id, part_num, content) VALUES (1, 2, ?);",
    (s) => s.bindBlob(1, content("part-2")),
  );
});

describe("partContent", () => {
  it("returns one part's content by part_num", () => {
    expect(owner.partContent(db, 1, 1)).toEqual(content("part-1"));
  });

  it("returns null when that part doesn't exist", () => {
    expect(owner.partContent(db, 1, 99)).toBeNull();
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
