// Exercises registerRemoteVfs's actual paging/caching/decryption logic
// directly, with a fake *synchronous* fetchPage (a plain in-memory lookup,
// no worker thread or network) -- everything remotePageWorker.ts's real
// worker+Atomics bridge would eventually call opts.fetchPage() to do, minus
// the cross-thread network hop itself. See testPerf.ts's comment for why
// that hop isn't verified end-to-end in this environment.
//
// This still proves the part unique to this feature: SQLite/SQLCipher, via
// this VFS, can open and correctly decrypt a real database while only ever
// being handed the specific pages it actually asks for, on demand, exactly
// once each (never the full byte image up front the way UserDb.resume does).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { UserDb } from "./userDb.ts";
import { loadWasm } from "./wasm.ts";
import { SqliteDb } from "./sqlite.ts";
import { registerRemoteVfs } from "./remoteVfs.ts";

function countRows(db: SqliteDb, sql: string): number {
  const stmt = db.prepare(sql);
  let rows = 0;
  while (stmt.step()) rows++;
  stmt.finalize();
  return rows;
}

async function buildRealUserDb(): Promise<{
  rootKey: Buffer;
  pages: Uint8Array[];
  pageSize: number;
  pageCount: number;
}> {
  const rootKey = randomBytes(256);
  const userDb = await UserDb.create(rootKey);
  const txtId1 = userDb.insertTxt(randomBytes(128), "doc-one.txt", null, Date.now());
  userDb.insertTxt(randomBytes(128), "doc-two.txt", null, Date.now());
  userDb.insertPart(txtId1, 0n, "path-0");
  userDb.insertPart(txtId1, 1n, "path-1");
  userDb.insertPart(txtId1, 2n, "path-2");
  const { bytes, pageSize, pageCount } = userDb.finish();
  const pages: Uint8Array[] = [];
  for (let i = 0; i < pageCount; i++) pages.push(bytes.subarray(i * pageSize, (i + 1) * pageSize));
  return { rootKey, pages, pageSize, pageCount };
}

test("registerRemoteVfs: opens and decrypts a real db from lazily-fetched pages, caching thereafter", async () => {
  const { rootKey, pages, pageSize, pageCount } = await buildRealUserDb();

  const fetchLog: number[] = [];
  const mod = await loadWasm();
  const backedPath = "/remote-test.db";
  const { name, stats } = registerRemoteVfs(mod, {
    pageSize,
    pageCount,
    backedPath,
    fetchPage: (pageNo) => {
      fetchLog.push(pageNo);
      const page = pages[pageNo - 1];
      if (!page) throw new Error(`test fetchPage: no such page ${pageNo}`);
      return page;
    },
  });

  const db = await SqliteDb.open(backedPath, { vfsName: name, rawKey: rootKey, readOnly: true });
  try {
    assert.equal(countRows(db, "SELECT * FROM txt;"), 2);
    assert.equal(countRows(db, "SELECT * FROM txt_parts;"), 3);

    const fetchesAfterFirstPass = fetchLog.length;
    assert.ok(fetchesAfterFirstPass > 0, "expected at least one lazy page fetch");
    assert.ok(fetchesAfterFirstPass <= pageCount, "must never fetch the same page twice");

    // Repeating the same queries must hit the in-session cache -- zero new fetches.
    assert.equal(countRows(db, "SELECT * FROM txt;"), 2);
    assert.equal(countRows(db, "SELECT * FROM txt_parts;"), 3);
    assert.equal(
      fetchLog.length,
      fetchesAfterFirstPass,
      "repeat queries must not re-fetch already-cached pages",
    );

    assert.equal(stats.roundtrips.length, fetchLog.length);
    assert.equal(stats.bytesFetched, fetchLog.length * pageSize);
  } finally {
    db.close();
  }
});
