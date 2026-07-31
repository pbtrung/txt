// End-to-end test for --convert-auto-vacuum: seeds a real vault (in.db),
// converts it into a fresh out.db, and verifies: in.db is left completely
// untouched, out.db's admin user database now reports auto_vacuum=2
// (INCREMENTAL) via a real PRAGMA query against the reconstructed bytes,
// content survives the conversion, and re-running against an out.db that
// already exists refuses rather than silently overwriting it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { RqliteDb } from "./rqliteDb.ts";
import { UserDb } from "./userDb.ts";
import { SqliteDb } from "./sqlite.ts";
import { ConvertAutoVacuumCommand } from "./commands.ts";

async function buildFixture(): Promise<{
  inDbPath: string;
  outDbPath: string;
  credsPath: string;
  rootKey: Buffer;
}> {
  const rootKey = randomBytes(256);
  const inDbPath = "/tmp/txt-convert-auto-vacuum-test-in.db";
  const outDbPath = "/tmp/txt-convert-auto-vacuum-test-out.db";
  for (const p of [inDbPath, outDbPath]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // fine, nothing to remove
    }
  }

  const rqliteDb = await RqliteDb.open(inDbPath);
  const { userId } = rqliteDb.ensureAdmin("test-api-key");

  const userDb = await UserDb.create(rootKey);
  userDb.insertTxt(randomBytes(128), "doc-one.txt", null, Date.now());
  userDb.insertTxt(randomBytes(128), "doc-two.txt", null, Date.now());
  const seeded = userDb.snapshot();
  rqliteDb.commit(userId, seeded.pageSize, seeded.bytes);
  rqliteDb.close();

  const credsPath = "/tmp/txt-convert-auto-vacuum-test-creds.json";
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      user_root_key: rootKey.toString("base64"),
      api_key: randomBytes(32).toString("base64"),
    }),
  );
  return { inDbPath, outDbPath, credsPath, rootKey };
}

async function autoVacuumMode(dbPath: string, rootKey: Buffer): Promise<number> {
  const rqliteDb = await RqliteDb.openExisting(dbPath, { readOnly: true });
  const userId = rqliteDb.findAdminUserId()!;
  const { bytes } = rqliteDb.latestPages(userId);
  rqliteDb.close();
  const userDb = await SqliteDb.open("/convert-auto-vacuum-test-check.db", {
    preload: bytes,
    rawKey: rootKey,
    readOnly: true,
  });
  const stmt = userDb.prepare("PRAGMA auto_vacuum;");
  stmt.step();
  const mode = Number(stmt.columnInt64(0));
  stmt.finalize();
  userDb.close();
  return mode;
}

async function survivingNames(dbPath: string, rootKey: Buffer): Promise<string[]> {
  const rqliteDb = await RqliteDb.openExisting(dbPath, { readOnly: true });
  const userId = rqliteDb.findAdminUserId()!;
  const { bytes } = rqliteDb.latestPages(userId);
  rqliteDb.close();
  const userDb = await SqliteDb.open("/convert-auto-vacuum-test-names.db", {
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

test("convert-auto-vacuum: converts a fresh copy to INCREMENTAL, leaves --in-db untouched, preserves content", async () => {
  const fixture = await buildFixture();

  const modeBefore = await autoVacuumMode(fixture.inDbPath, fixture.rootKey);
  assert.equal(modeBefore, 0, "a freshly-created vault should default to auto_vacuum=NONE");
  const inDbBytesBefore = fs.readFileSync(fixture.inDbPath);

  await new ConvertAutoVacuumCommand({
    credsPath: fixture.credsPath,
    inDbPath: fixture.inDbPath,
    outDbPath: fixture.outDbPath,
    verbose: true,
  }).run();

  assert.deepEqual(
    fs.readFileSync(fixture.inDbPath),
    inDbBytesBefore,
    "--in-db must be left completely untouched",
  );

  const modeAfter = await autoVacuumMode(fixture.outDbPath, fixture.rootKey);
  assert.equal(
    modeAfter,
    2,
    "--out-db's user database should now report auto_vacuum=INCREMENTAL (2)",
  );

  const names = await survivingNames(fixture.outDbPath, fixture.rootKey);
  assert.deepEqual(names, ["doc-one.txt", "doc-two.txt"], "content must survive the conversion");

  await assert.rejects(
    new ConvertAutoVacuumCommand({
      credsPath: fixture.credsPath,
      inDbPath: fixture.inDbPath,
      outDbPath: fixture.outDbPath,
      verbose: false,
    }).run(),
    /already exists/,
    "must refuse to overwrite an existing --out-db",
  );
});
