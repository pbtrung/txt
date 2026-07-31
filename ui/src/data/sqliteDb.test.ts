// Exercises SqliteDb/Statement's own real WASM-backed SQLite calls directly
// (no remoteVfs involved -- a plain in-memory MEMFS-backed db), focused on
// the write-path correctness gap this file used to have: stepDone() called
// sqlite3_step() but discarded its return code entirely, so a failed
// INSERT/UPDATE/DELETE (a constraint violation, for instance) looked
// identical to a successful one from the caller's side.

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SqliteDb } from "./sqliteDb";

let dbCounter = 0;

async function openTestDb(): Promise<SqliteDb> {
  const rootKey = randomBytes(256);
  const db = await SqliteDb.open(`/sqlite-db-test-${dbCounter++}.db`, { rawKey: rootKey });
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n INTEGER);");
  db.run("INSERT INTO t (id, name, n) VALUES (1, 'a', 1);");
  return db;
}

describe("SqliteDb.changes()", () => {
  it("reports 1 after an UPDATE that matches exactly one row", async () => {
    const db = await openTestDb();
    db.run("UPDATE t SET n = 99 WHERE id = 1;");
    expect(db.changes()).toBe(1);
    db.close();
  });

  it("reports 0 after an UPDATE whose WHERE clause matches nothing -- a silent no-op, not an error", async () => {
    const db = await openTestDb();
    db.run("UPDATE t SET n = 99 WHERE id = 999;");
    expect(db.changes()).toBe(0);
    db.close();
  });
});

describe("Statement.stepDone()", () => {
  it("throws for a genuine constraint violation instead of silently swallowing it", async () => {
    const db = await openTestDb();
    db.run("INSERT INTO t (id, name, n) VALUES (2, 'b', 2);");
    expect(() => db.run("INSERT INTO t (id, name, n) VALUES (3, 'a', 3);")).toThrow(
      "stepDone failed",
    );
    db.close();
  });

  it("does not throw for an ordinary successful write", async () => {
    const db = await openTestDb();
    expect(() => db.run("INSERT INTO t (id, name, n) VALUES (2, 'b', 2);")).not.toThrow();
    db.close();
  });
});
