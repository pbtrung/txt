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
import http from "node:http";
import { randomBytes } from "node:crypto";
import { UserDb } from "./userDb.ts";
import { loadWasm } from "./wasm.ts";
import { SqliteDb } from "./sqlite.ts";
import { registerRemoteVfs } from "./remoteVfs.ts";
import { RqliteHttpClient } from "./rqliteHttpClient.ts";

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

test("registerRemoteVfs.primeCache: pre-seeded pages are read without ever calling fetchPage", async () => {
  const { rootKey, pages, pageSize, pageCount } = await buildRealUserDb();

  const mod = await loadWasm();
  const backedPath = "/remote-test-primed.db";
  const vfs = registerRemoteVfs(mod, {
    pageSize,
    pageCount,
    backedPath,
    fetchPage: () => {
      throw new Error("test fetchPage: should never be called -- every page was primed");
    },
  });
  const primed = new Map<number, Uint8Array>();
  for (let i = 0; i < pageCount; i++) primed.set(i + 1, pages[i]!);
  vfs.primeCache(primed);

  const db = await SqliteDb.open(backedPath, {
    vfsName: vfs.name,
    rawKey: rootKey,
    readOnly: true,
  });
  try {
    assert.equal(countRows(db, "SELECT * FROM txt;"), 2);
    assert.equal(countRows(db, "SELECT * FROM txt_parts;"), 3);
    assert.equal(vfs.stats.roundtrips.length, 0, "no page should need a real fetch after priming");
  } finally {
    db.close();
  }
});

/** A tiny fake page store behind a real HTTP server -- COMMIT is the only
 * statement actually exercised over the wire (fetchPage below reads
 * straight out of the same in-memory map, exactly like prefetch bypasses a
 * real network round trip in the real app); this is what TestWriteCommand's
 * commit() call round-trips against. Keyed by `${pageNo}@${version}` so a
 * later fetch can find the latest version at or before a given snapshot,
 * mirroring auth_perms.lua's own READ_PAGE query. */
function startFakePageStore(): Promise<{
  port: number;
  pages: Map<string, Buffer>;
  currentVersion: () => number;
  close: () => Promise<void>;
}> {
  const pages = new Map<string, Buffer>();
  let version = 1;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const won = body.commit.old_version === version;
      if (won) {
        for (const p of body.commit.pages)
          pages.set(`${p.page_no}@${body.commit.new_version}`, Buffer.from(p.data));
        version = body.commit.new_version;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { rows_affected: won ? body.commit.pages.length : 0 },
            { rows_affected: won ? 1 : 0 },
          ],
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        pages,
        currentVersion: () => version,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function latestPageAtOrBefore(
  pages: Map<string, Buffer>,
  pageNo: number,
  snapshot: number,
): Uint8Array {
  for (let v = snapshot; v >= 1; v--) {
    const page = pages.get(`${pageNo}@${v}`);
    if (page) return page;
  }
  throw new Error(`test fetchPage: no version of page ${pageNo} at or before ${snapshot}`);
}

test("registerRemoteVfs: a write committed by one session is visible to an entirely separate second session", async () => {
  const { rootKey, pages: initialPages, pageSize, pageCount } = await buildRealUserDb();
  const store = await startFakePageStore();
  for (let i = 0; i < pageCount; i++) store.pages.set(`${i + 1}@1`, Buffer.from(initialPages[i]!));

  try {
    const mod = await loadWasm();
    const write = registerRemoteVfs(mod, {
      pageSize,
      pageCount,
      currentVersion: 1,
      backedPath: "/remote-write.db",
      fetchPage: (pageNo) => latestPageAtOrBefore(store.pages, pageNo, 1),
    });
    const writeDb = await SqliteDb.open("/remote-write.db", {
      vfsName: write.name,
      rawKey: rootKey,
    });
    writeDb.run(
      "INSERT INTO txt (txt_key, name, metadata, created_at) VALUES (?, ?, NULL, ?);",
      (s) => {
        s.bindBlob(1, randomBytes(128));
        s.bindText(2, "doc-three.txt");
        s.bindInt64(3, Date.now());
      },
    );
    const client = new RqliteHttpClient(`http://127.0.0.1:${store.port}`, "key");
    const committed = await write.commit(client);
    writeDb.close();

    assert.equal(committed, true);
    assert.equal(store.currentVersion(), 2);

    const read = registerRemoteVfs(mod, {
      pageSize,
      pageCount,
      currentVersion: 2,
      backedPath: "/remote-read.db",
      fetchPage: (pageNo) => latestPageAtOrBefore(store.pages, pageNo, 2),
    });
    const readDb = await SqliteDb.open("/remote-read.db", {
      vfsName: read.name,
      rawKey: rootKey,
      readOnly: true,
    });
    assert.equal(countRows(readDb, "SELECT * FROM txt WHERE name = 'doc-three.txt';"), 1);
    readDb.close();
  } finally {
    await store.close();
  }
});
