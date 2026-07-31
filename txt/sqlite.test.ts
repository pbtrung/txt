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

// Regression test for docker/auth_perms.lua's build_commit_statements: its
// guarded page INSERT used "FROM (VALUES ...) AS dirty(db_id, page_no,
// version, data)" -- naming a derived table's columns via an explicit alias
// list -- which is a newer SQLite grammar addition than the version rqlite
// bundles, and failed with "near '(': syntax error" on every single commit,
// silently (nothing checked this statement's own result before). Confirmed
// failing identically against this project's own vendored SQLite build
// before being fixed to select SQLite's own default column1/column2/...
// names off an anonymous derived table instead. This test freezes the fix:
// if this pattern is ever "cleaned up" back to the named form, it fails
// immediately instead of silently breaking every commit again.
test("guarded page INSERT pattern (docker/auth_perms.lua's build_commit_statements) parses and runs against the real vendored SQLite", async () => {
  const db = await openTestDb();
  db.exec("CREATE TABLE pages (db_id TEXT, page_no INTEGER, version INTEGER, data BLOB);");
  db.exec("CREATE TABLE db_meta (db_id TEXT, current_version INTEGER);");
  db.run("INSERT INTO db_meta VALUES ('u1', 5);");

  db.run(
    "INSERT INTO pages (db_id, page_no, version, data) " +
      "SELECT column1, column2, column3, column4 FROM (VALUES (?,?,?,?), (?,?,?,?)) " +
      "WHERE (SELECT current_version FROM db_meta WHERE db_id = ?) = ?;",
    (s) => {
      s.bindText(1, "u1");
      s.bindInt64(2, 1);
      s.bindInt64(3, 6);
      s.bindBlob(4, new Uint8Array([1, 2, 3]));
      s.bindText(5, "u1");
      s.bindInt64(6, 2);
      s.bindInt64(7, 6);
      s.bindBlob(8, new Uint8Array([4, 5, 6]));
      s.bindText(9, "u1");
      s.bindInt64(10, 5);
    },
  );
  assert.equal(db.changes(), 2);
  db.close();
});
