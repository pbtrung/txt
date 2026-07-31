// End-to-end test for --update-db: seeds a fresh admin user database (no
// documents needed -- this command only ever touches r2_config), writes an
// r2_config row from a creds.json's r2_config field, then reconstructs the
// database from rqlite_txt.db to confirm the row landed with the right
// values. A second run with different values proves it's an upsert (still
// exactly one row, not a duplicate or a append).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { RqliteDb } from "./rqliteDb.ts";
import { UserDb } from "./userDb.ts";
import { SqliteDb } from "./sqlite.ts";
import { UpdateDbCommand } from "./commands.ts";
import type { R2Config } from "./creds.ts";

async function buildFixture(): Promise<{ dbPath: string; rootKey: Buffer }> {
  const rootKey = randomBytes(256);
  const dbPath = "/tmp/txt-update-db-test-rqlite.db";
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // fine, nothing to remove
  }

  const rqliteDb = await RqliteDb.open(dbPath);
  const { userId } = rqliteDb.ensureAdmin("test-api-key");
  const userDb = await UserDb.create(rootKey);
  const seeded = userDb.snapshot();
  rqliteDb.commit(userId, seeded.pageSize, seeded.bytes);
  rqliteDb.close();

  return { dbPath, rootKey };
}

function writeCreds(rootKey: Buffer, r2Config: R2Config): string {
  const credsPath = "/tmp/txt-update-db-test-creds.json";
  fs.writeFileSync(
    credsPath,
    JSON.stringify({ user_root_key: rootKey.toString("base64"), r2_config: r2Config }),
  );
  return credsPath;
}

async function readR2Config(dbPath: string, rootKey: Buffer): Promise<unknown[][]> {
  const rqliteDb = await RqliteDb.openExisting(dbPath, { readOnly: true });
  const userId = rqliteDb.findAdminUserId()!;
  const { bytes } = rqliteDb.latestPages(userId);
  rqliteDb.close();
  const userDb = await SqliteDb.open("/update-db-test-check.db", {
    preload: bytes,
    rawKey: rootKey,
    readOnly: true,
  });
  const stmt = userDb.prepare(
    "SELECT id, endpoint, region, bucket, read_only_access_key_id, read_only_secret_access_key, read_write_access_key_id, read_write_secret_access_key FROM r2_config;",
  );
  const rows: unknown[][] = [];
  while (stmt.step()) {
    rows.push([
      stmt.columnInt64(0),
      stmt.columnText(1),
      stmt.columnText(2),
      stmt.columnText(3),
      stmt.columnText(4),
      stmt.columnText(5),
      stmt.columnText(6),
      stmt.columnText(7),
    ]);
  }
  stmt.finalize();
  userDb.close();
  return rows;
}

test("update-db: writes r2_config's single row into the admin's user database", async () => {
  const fixture = await buildFixture();
  const r2Config: R2Config = {
    endpoint: "https://r2.example.com",
    region: "auto",
    bucket: "txt-bucket",
    read_only_access_key_id: "ro-id-1",
    read_only_secret_access_key: "ro-secret-1",
    read_write_access_key_id: "rw-id-1",
    read_write_secret_access_key: "rw-secret-1",
  };
  const credsPath = writeCreds(fixture.rootKey, r2Config);

  await new UpdateDbCommand({ credsPath, dbPath: fixture.dbPath, verbose: true }).run();

  const rows = await readR2Config(fixture.dbPath, fixture.rootKey);
  assert.deepEqual(rows, [
    [
      1n,
      "https://r2.example.com",
      "auto",
      "txt-bucket",
      "ro-id-1",
      "ro-secret-1",
      "rw-id-1",
      "rw-secret-1",
    ],
  ]);

  // Re-running with different values upserts in place -- still one row, not
  // a duplicate or a second insert.
  const updatedConfig: R2Config = { ...r2Config, bucket: "txt-bucket-2", region: "us-east-1" };
  const credsPath2 = writeCreds(fixture.rootKey, updatedConfig);
  await new UpdateDbCommand({
    credsPath: credsPath2,
    dbPath: fixture.dbPath,
    verbose: false,
  }).run();

  const rowsAfter = await readR2Config(fixture.dbPath, fixture.rootKey);
  assert.deepEqual(rowsAfter, [
    [
      1n,
      "https://r2.example.com",
      "us-east-1",
      "txt-bucket-2",
      "ro-id-1",
      "ro-secret-1",
      "rw-id-1",
      "rw-secret-1",
    ],
  ]);
});

test("update-db: no admin account -> logs and does nothing", async () => {
  const dbPath = "/tmp/txt-update-db-test-no-admin.db";
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // fine, nothing to remove
  }
  const rqliteDb = await RqliteDb.open(dbPath);
  rqliteDb.close();

  const rootKey = randomBytes(256);
  const credsPath = writeCreds(rootKey, {
    endpoint: "https://r2.example.com",
    region: "auto",
    bucket: "txt-bucket",
    read_only_access_key_id: "ro-id",
    read_only_secret_access_key: "ro-secret",
    read_write_access_key_id: "rw-id",
    read_write_secret_access_key: "rw-secret",
  });

  // Should not throw -- just a no-op with a log line, same as --vacuum's
  // own "no admin account found" branch.
  await new UpdateDbCommand({ credsPath, dbPath, verbose: false }).run();
});
