import { beforeEach, describe, expect, it } from "vitest";

import { SqliteDb } from "./sqliteDb";
import * as access from "./access";

let db: SqliteDb;
let dbCounter = 0;

beforeEach(async () => {
  const rootKey = new Uint8Array(256).fill(9);
  db = await SqliteDb.open(`/access-test-${dbCounter++}.db`, {
    rawKey: rootKey,
  });
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

// No production reader queries a single document's position in isolation
// (library.ts's loadLibrary reads last_part_num/last_accessed for the whole
// library in one query instead) -- this stands in as a test-only assertion
// helper for setReadPosition/clearReadPosition's column writes.
function readPosition(txtId: number): access.ReadPosition | null {
  const stmt = db.prepare(
    "SELECT last_part_num, last_accessed FROM txt WHERE id = ?",
  );
  stmt.bindInt64(1, txtId);
  const found = stmt.step();
  const position =
    found && !stmt.columnIsNull(0)
      ? {
          lastPartNum: Number(stmt.columnInt64(0)),
          lastAccessedMs: Number(stmt.columnInt64(1)),
        }
      : null;
  stmt.finalize();
  return position;
}

describe("setReadPosition", () => {
  it("returns null before a document has ever been opened", () => {
    expect(readPosition(1)).toBeNull();
  });

  it("records a position that reads back correctly", () => {
    access.setReadPosition(db, 1, 3, 5000);
    expect(readPosition(1)).toEqual({ lastPartNum: 3, lastAccessedMs: 5000 });
  });

  it("overwrites a previously recorded position", () => {
    access.setReadPosition(db, 1, 1, 1000);
    access.setReadPosition(db, 1, 7, 9000);
    expect(readPosition(1)).toEqual({ lastPartNum: 7, lastAccessedMs: 9000 });
  });
});

describe("clearReadPosition", () => {
  it("resets a recorded position back to never-opened", () => {
    access.setReadPosition(db, 1, 3, 5000);
    access.clearReadPosition(db, 1);
    expect(readPosition(1)).toBeNull();
  });
});
