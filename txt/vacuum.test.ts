// End-to-end test for --vacuum: seeds a user database with enough documents
// that deleting half of them frees whole pages (not just in-page slack),
// then walks the realistic operator workflow -- vacuum, collect-garbage,
// vacuum again -- verifying the user database shrinks immediately and
// rqlite_txt.db itself only shrinks once collect-garbage has reclaimed the
// page versions vacuum's rewrite left behind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import fs, { statSync } from "node:fs";
import { RqliteDb } from "./rqliteDb.ts";
import { UserDb } from "./userDb.ts";
import { SqliteDb } from "./sqlite.ts";
import { VacuumCommand } from "./vacuum.ts";
import { CollectGarbageCommand } from "./collectGarbage.ts";

const DOC_COUNT = 200;

async function buildFixtureWithFreeSpace(): Promise<{
  dbPath: string;
  credsPath: string;
  rootKey: Buffer;
}> {
  const rootKey = randomBytes(256);
  const dbPath = "/tmp/txt-vacuum-test-rqlite.db";
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // fine, nothing to remove
  }

  const rqliteDb = await RqliteDb.open(dbPath);
  const { userId } = rqliteDb.ensureAdmin({ tierId: "free", rate: 10, burst: 20 }, "test-api-key");

  const userDb = await UserDb.create(rootKey);
  const padding = brotliCompressSync(randomBytes(2000)); // incompressible -- keeps rows page-sized
  for (let i = 0; i < DOC_COUNT; i++) {
    const txtId = userDb.insertTxt(randomBytes(128), `doc-${i}.txt`, padding, Date.now());
    userDb.insertPart(txtId, 0n, `path-${i}-0`.padEnd(52, "0"));
  }
  const seeded = userDb.snapshot();
  rqliteDb.commit(userId, seeded.pageSize, seeded.bytes);

  // Simulate deletions (no production code path does this yet) to create
  // free pages for VACUUM to reclaim, via a plain connection to the same
  // reconstructed bytes.
  const raw = await SqliteDb.open("/vacuum-test-delete.db", {
    preload: seeded.bytes,
    rawKey: rootKey,
  });
  raw.exec("DELETE FROM txt WHERE id % 2 = 0;");
  const afterDelete = raw.readBytes();
  raw.close();
  rqliteDb.commit(userId, seeded.pageSize, afterDelete);
  rqliteDb.close();

  const credsPath = "/tmp/txt-vacuum-test-creds.json";
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      user_root_key: rootKey.toString("base64"),
      api_key: randomBytes(32).toString("base64"),
    }),
  );
  return { dbPath, credsPath, rootKey };
}

async function reconstructedUserDbSize(dbPath: string): Promise<number> {
  const rqliteDb = await RqliteDb.openExisting(dbPath, { readOnly: true });
  const userId = rqliteDb.findAdminUserId()!;
  const { bytes } = rqliteDb.latestPages(userId);
  rqliteDb.close();
  return bytes.length;
}

async function survivingNames(dbPath: string, rootKey: Buffer): Promise<string[]> {
  const rqliteDb = await RqliteDb.openExisting(dbPath, { readOnly: true });
  const userId = rqliteDb.findAdminUserId()!;
  const { bytes } = rqliteDb.latestPages(userId);
  rqliteDb.close();
  const userDb = await SqliteDb.open("/vacuum-test-check.db", {
    preload: bytes,
    rawKey: rootKey,
    readOnly: true,
  });
  const stmt = userDb.prepare("SELECT name FROM txt ORDER BY name;");
  const names: string[] = [];
  while (stmt.step()) names.push(stmt.columnText(0));
  stmt.finalize();
  userDb.close();
  return names;
}

test("vacuum: a single run shrinks both the user db and rqlite_txt.db itself", async () => {
  const fixture = await buildFixtureWithFreeSpace();
  const namesBefore = await survivingNames(fixture.dbPath, fixture.rootKey);
  assert.equal(namesBefore.length, DOC_COUNT / 2, "half the documents should have been deleted");

  const userDbSizeBefore = await reconstructedUserDbSize(fixture.dbPath);
  const rqliteSizeBefore = statSync(fixture.dbPath).size;
  await new VacuumCommand({
    credsPath: fixture.credsPath,
    dbPath: fixture.dbPath,
    verbose: true,
  }).run();
  const userDbSizeAfter = await reconstructedUserDbSize(fixture.dbPath);
  const rqliteSizeAfter = statSync(fixture.dbPath).size;
  assert.ok(
    userDbSizeAfter < userDbSizeBefore,
    `vacuum should shrink the reconstructed user db (${userDbSizeBefore} -> ${userDbSizeAfter})`,
  );
  assert.ok(
    rqliteSizeAfter < rqliteSizeBefore,
    // vacuum's own rewrite supersedes nearly every page; without collecting
    // that garbage before its own VACUUM, rqlite_txt.db would only grow
    `a single vacuum should shrink rqlite_txt.db too, by collecting its own stale pages first (${rqliteSizeBefore} -> ${rqliteSizeAfter})`,
  );

  const namesAfterVacuum = await survivingNames(fixture.dbPath, fixture.rootKey);
  assert.deepEqual(
    namesAfterVacuum,
    namesBefore,
    "vacuum must not change surviving document content",
  );

  // A follow-up collect-garbage/vacuum should now find nothing left to do.
  await new CollectGarbageCommand({ dbPath: fixture.dbPath, dryRun: false, verbose: false }).run();
  const rqliteSizeStable = statSync(fixture.dbPath).size;
  await new VacuumCommand({
    credsPath: fixture.credsPath,
    dbPath: fixture.dbPath,
    verbose: false,
  }).run();
  assert.equal(
    statSync(fixture.dbPath).size,
    rqliteSizeStable,
    "a second vacuum with nothing new to reclaim should not change rqlite_txt.db's size",
  );

  const namesAfterAll = await survivingNames(fixture.dbPath, fixture.rootKey);
  assert.deepEqual(namesAfterAll, namesBefore, "content must survive the whole cycle");
});
