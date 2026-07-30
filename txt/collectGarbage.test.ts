// End-to-end test for --collect-garbage: commits a few versions of a real
// temp user database (creating superseded page versions to sweep), adds one
// expired and one still-valid reader lease, then verifies dry-run changes
// nothing, a real run removes exactly the garbage (and nothing else -- the
// reconstructed current state must be byte-identical before and after), and
// a second run with nothing new to do is a no-op.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { RqliteDb } from "./rqliteDb.ts";
import { UserDb } from "./userDb.ts";
import { SqliteDb } from "./sqlite.ts";
import { CollectGarbageCommand } from "./collectGarbage.ts";

async function countRows(dbPath: string, sql: string): Promise<number> {
  const db = await SqliteDb.open("/collect-garbage-test-inspect.db", {
    preload: fs.readFileSync(dbPath),
    readOnly: true,
  });
  const stmt = db.prepare(sql);
  stmt.step();
  const count = Number(stmt.columnInt64(0));
  stmt.finalize();
  db.close();
  return count;
}

async function remainingReaderIds(dbPath: string): Promise<string[]> {
  const db = await SqliteDb.open("/collect-garbage-test-inspect.db", {
    preload: fs.readFileSync(dbPath),
    readOnly: true,
  });
  const stmt = db.prepare("SELECT reader_id FROM active_readers ORDER BY reader_id;");
  const ids: string[] = [];
  while (stmt.step()) ids.push(stmt.columnText(0));
  stmt.finalize();
  db.close();
  return ids;
}

test("collect-garbage: dry-run changes nothing, a real run removes only superseded pages", async () => {
  const dbPath = "/tmp/txt-collect-garbage-test-rqlite.db";
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // fine, nothing to remove
  }

  const rootKey = randomBytes(256);
  const rqliteDb = await RqliteDb.open(dbPath);
  const { userId } = rqliteDb.ensureAdmin({ tierId: "free", rate: 10, burst: 20 });

  const userDb = await UserDb.create(rootKey);
  const commit = () => {
    const snap = userDb.snapshot();
    rqliteDb.commit(userId, snap.pageSize, snap.bytes);
  };
  commit(); // version 1: schema only
  userDb.insertTxt(randomBytes(128), "doc-one.txt", null, Date.now());
  commit(); // version 2: adds a document
  userDb.insertTxt(randomBytes(128), "doc-two.txt", null, Date.now());
  commit(); // version 3: adds another -- some version-2 pages are now superseded

  rqliteDb.insertActiveReader(userId, "expired-reader", 1, Date.now() - 1000);
  rqliteDb.insertActiveReader(userId, "live-reader", 2, Date.now() + 1_000_000);
  rqliteDb.flush();
  rqliteDb.close();

  const beforePages = await countRows(dbPath, "SELECT count(*) FROM pages;");
  const beforeBytes = (await RqliteDb.openExisting(dbPath, { readOnly: true })).latestPages(
    userId,
  ).bytes;

  await new CollectGarbageCommand({ dbPath, dryRun: true, verbose: false }).run();
  assert.equal(
    await countRows(dbPath, "SELECT count(*) FROM pages;"),
    beforePages,
    "dry-run must not delete pages",
  );
  assert.equal(
    await countRows(dbPath, "SELECT count(*) FROM active_readers;"),
    2,
    "dry-run must not delete reader leases",
  );
  assert.equal(
    await countRows(dbPath, "SELECT needs_gc FROM db_meta;"),
    1,
    "dry-run must not clear needs_gc",
  );

  await new CollectGarbageCommand({ dbPath, dryRun: false, verbose: true }).run();
  const afterPages = await countRows(dbPath, "SELECT count(*) FROM pages;");
  assert.ok(afterPages < beforePages, "a real run should remove superseded page versions");
  assert.deepEqual(
    await remainingReaderIds(dbPath),
    ["live-reader"],
    "only the expired reader should be removed",
  );
  assert.equal(
    await countRows(dbPath, "SELECT needs_gc FROM db_meta;"),
    0,
    "a real run clears needs_gc",
  );
  assert.equal(
    await countRows(dbPath, "SELECT count(*) FROM gc_runs;"),
    1,
    "a real run records today's gc_runs row",
  );

  const afterBytes = (await RqliteDb.openExisting(dbPath, { readOnly: true })).latestPages(
    userId,
  ).bytes;
  assert.deepEqual(afterBytes, beforeBytes, "reconstructed current state must be unchanged by GC");

  await new CollectGarbageCommand({ dbPath, dryRun: false, verbose: false }).run();
  assert.equal(
    await countRows(dbPath, "SELECT count(*) FROM pages;"),
    afterPages,
    "a second run with nothing new to do must be a no-op",
  );
});
