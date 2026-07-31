// Verifies the actual PRAGMA incremental_vacuum(N) mechanics --remote-vacuum
// relies on: it only reclaims anything on a database already converted to
// auto_vacuum=INCREMENTAL (via --convert-auto-vacuum), and is a harmless
// no-op otherwise. Exercises real SQLite directly (no worker/VFS/network --
// that round trip is covered the same way --test-write's is, see docs/cli.md),
// since the interesting behavior here is entirely in what the PRAGMA itself
// does, not in how its resulting dirty pages get committed (already covered
// by remoteVfs.test.ts's write+commit test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { UserDb } from "./userDb.ts";
import { SqliteDb } from "./sqlite.ts";

const DOC_COUNT = 100;

async function seedDbWithFreeSpace(rootKey: Buffer): Promise<Uint8Array> {
  const userDb = await UserDb.create(rootKey);
  const padding = brotliCompressSync(randomBytes(2000)); // incompressible -- keeps rows page-sized
  for (let i = 0; i < DOC_COUNT; i++) {
    const txtId = userDb.insertTxt(randomBytes(128), `doc-${i}.txt`, padding, Date.now());
    userDb.insertPart(txtId, 0n, `path-${i}-0`.padEnd(52, "0"));
  }
  const seeded = userDb.snapshot();
  const raw = await SqliteDb.open("/incremental-vacuum-test-delete.db", {
    preload: seeded.bytes,
    rawKey: rootKey,
  });
  raw.exec("DELETE FROM txt WHERE id % 2 = 0;"); // frees whole pages, not just in-page slack
  const afterDelete = raw.readBytes();
  raw.close();
  return afterDelete;
}

async function pageCount(bytes: Uint8Array, rootKey: Buffer): Promise<number> {
  const db = await SqliteDb.open("/incremental-vacuum-test-check.db", {
    preload: bytes,
    rawKey: rootKey,
    readOnly: true,
  });
  const stmt = db.prepare("PRAGMA page_count;");
  stmt.step();
  const count = Number(stmt.columnInt64(0));
  stmt.finalize();
  db.close();
  return count;
}

test("incremental_vacuum(N): reclaims pages on a converted database", async () => {
  const rootKey = randomBytes(256);
  const bytesWithFreeSpace = await seedDbWithFreeSpace(rootKey);

  const db = await SqliteDb.open("/incremental-vacuum-test-convert.db", {
    preload: bytesWithFreeSpace,
    rawKey: rootKey,
  });
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  db.exec("VACUUM;"); // only a VACUUM after setting the pragma actually applies it
  const converted = db.readBytes();
  db.close();

  const pageCountBefore = await pageCount(converted, rootKey);

  const db2 = await SqliteDb.open("/incremental-vacuum-test-run.db", {
    preload: converted,
    rawKey: rootKey,
  });
  db2.exec("DELETE FROM txt WHERE id % 4 = 1;"); // free more pages to reclaim
  db2.exec("PRAGMA incremental_vacuum(50);");
  const afterVacuum = db2.readBytes();
  db2.close();

  const pageCountAfter = await pageCount(afterVacuum, rootKey);
  assert.ok(
    pageCountAfter < pageCountBefore,
    `incremental_vacuum should shrink page_count (${pageCountBefore} -> ${pageCountAfter})`,
  );

  const check = await SqliteDb.open("/incremental-vacuum-test-verify.db", {
    preload: afterVacuum,
    rawKey: rootKey,
    readOnly: true,
  });
  const stmt = check.prepare("SELECT count(*) FROM txt;");
  stmt.step();
  const remaining = Number(stmt.columnInt64(0));
  stmt.finalize();
  check.close();
  assert.ok(remaining > 0, "surviving documents must still be readable after reclaiming space");
});

test("incremental_vacuum(N): a harmless no-op on a database still auto_vacuum=NONE", async () => {
  const rootKey = randomBytes(256);
  const bytes = await seedDbWithFreeSpace(rootKey);
  const pageCountBefore = await pageCount(bytes, rootKey);

  const db = await SqliteDb.open("/incremental-vacuum-test-noop.db", {
    preload: bytes,
    rawKey: rootKey,
  });
  const modeStmt = db.prepare("PRAGMA auto_vacuum;");
  modeStmt.step();
  assert.equal(
    Number(modeStmt.columnInt64(0)),
    0,
    "sanity: this database is still auto_vacuum=NONE",
  );
  modeStmt.finalize();

  db.exec("PRAGMA incremental_vacuum(50);");
  const afterBytes = db.readBytes();
  db.close();

  assert.equal(
    await pageCount(afterBytes, rootKey),
    pageCountBefore,
    "incremental_vacuum on a NONE database must not change anything",
  );
});
