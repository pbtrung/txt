import { beforeEach, describe, expect, it } from "vitest";

import { SqliteDb } from "./sqliteDb";
import * as access from "./access";

let db: SqliteDb;
let dbCounter = 0;

beforeEach(async () => {
  const rootKey = new Uint8Array(256).fill(9);
  db = await SqliteDb.open(`/access-test-${dbCounter++}.db`, { rawKey: rootKey });
  db.exec(`
    CREATE TABLE txt (
      id            INTEGER PRIMARY KEY,
      name          TEXT NOT NULL,
      last_part_num INTEGER,
      last_accessed INTEGER
    );
  `);
  db.run("INSERT INTO txt (id, name) VALUES (1, 'doc-one.txt');");
});

describe("getReadPosition", () => {
  it("returns null before a document has ever been opened", () => {
    expect(access.getReadPosition(db, 1)).toBeNull();
  });

  it("returns the recorded position after setReadPosition", () => {
    access.setReadPosition(db, 1, 3, 5000);
    expect(access.getReadPosition(db, 1)).toEqual({ lastPartNum: 3, lastAccessedMs: 5000 });
  });

  it("returns null for a nonexistent txt_id", () => {
    expect(access.getReadPosition(db, 999)).toBeNull();
  });
});

describe("setReadPosition", () => {
  it("overwrites a previously recorded position", () => {
    access.setReadPosition(db, 1, 1, 1000);
    access.setReadPosition(db, 1, 7, 9000);
    expect(access.getReadPosition(db, 1)).toEqual({ lastPartNum: 7, lastAccessedMs: 9000 });
  });
});
