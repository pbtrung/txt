// Exercises SqliteDb/Statement's own real WASM-backed SQLite calls directly
// (no remoteVfs involved -- a plain in-memory MEMFS-backed db), focused on
// the write-path correctness gap this file used to have: stepDone() called
// sqlite3_step() but discarded its return code entirely, so a failed
// INSERT/UPDATE/DELETE (a constraint violation, for instance) looked
// identical to a successful one from the caller's side. Mirrors ui/'s
// sqliteDb.test.ts, which found and fixed the same gap in the browser port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SqliteDb } from "./sqlite.ts";

let dbCounter = 0;

async function openTestDb(): Promise<SqliteDb> {
  const rootKey = randomBytes(256);
  const db = await SqliteDb.open(`/sqlite-db-test-${dbCounter++}.db`, { rawKey: rootKey });
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n INTEGER);");
  db.run("INSERT INTO t (id, name, n) VALUES (1, 'a', 1);");
  return db;
}

test("SqliteDb.changes(): reports 1 after an UPDATE that matches exactly one row", async () => {
  const db = await openTestDb();
  db.run("UPDATE t SET n = 99 WHERE id = 1;");
  assert.equal(db.changes(), 1);
  db.close();
});

test("SqliteDb.changes(): reports 0 after an UPDATE whose WHERE clause matches nothing", async () => {
  const db = await openTestDb();
  db.run("UPDATE t SET n = 99 WHERE id = 999;");
  assert.equal(db.changes(), 0);
  db.close();
});

test("Statement.stepDone(): throws for a genuine constraint violation instead of silently swallowing it", async () => {
  const db = await openTestDb();
  db.run("INSERT INTO t (id, name, n) VALUES (2, 'b', 2);");
  assert.throws(() => db.run("INSERT INTO t (id, name, n) VALUES (3, 'a', 3);"), /stepDone failed/);
  db.close();
});

test("Statement.stepDone(): does not throw for an ordinary successful write", async () => {
  const db = await openTestDb();
  assert.doesNotThrow(() => db.run("INSERT INTO t (id, name, n) VALUES (2, 'b', 2);"));
  db.close();
});
