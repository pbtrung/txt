// Exercises registerRemoteVfs's real paging/caching/decryption logic (fake
// *synchronous* fetchPage -- a plain in-memory lookup, no worker/network,
// same scope as txt/remoteVfs.test.ts) plus the write/commit path that file
// doesn't have at all (txt/ only ever reads). Proves: SQLite can open and
// decrypt a real db while only ever being handed pages it actually asks
// for; writes stay in memory until an explicit commit(); commit() sends
// exactly the dirty pages plus the correct old/new version and page count;
// a lost CAS (commit's fake client returns false) leaves dirty pages intact
// so the caller can retry.

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { loadWasm } from "./wasmLoader";
import { SqliteDb } from "./sqliteDb";
import { registerRemoteVfs } from "./remoteVfs";
import type { CommitPage, RqliteHttpClient } from "./rqliteHttpClient";

interface RealDb {
  rootKey: Uint8Array;
  pages: Uint8Array[];
  pageSize: number;
  pageCount: number;
}

let buildCounter = 0;

async function buildRealDb(): Promise<RealDb> {
  const rootKey = randomBytes(256);
  // Unique per call -- loadWasm()'s module (and its MEMFS) is memoized and
  // shared across every test in this file, so a fixed path here would have
  // the second test's open() hit the first test's (differently-keyed) file.
  const path = `/remote-vfs-build-${buildCounter++}.db`;
  const db = await SqliteDb.open(path, { rawKey: rootKey });
  const pageSizeStmt = db.prepare("PRAGMA page_size;");
  pageSizeStmt.step();
  const pageSize = Number(pageSizeStmt.columnInt64(0));
  pageSizeStmt.finalize();

  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);");
  db.run("INSERT INTO t (name) VALUES (?);", (s) => s.bindText(1, "hello"));
  db.run("INSERT INTO t (name) VALUES (?);", (s) => s.bindText(1, "world"));
  db.close();

  const mod = await loadWasm();
  const bytes = mod.FS.readFile(path);
  const pageCount = bytes.length / pageSize;
  const pages: Uint8Array[] = [];
  for (let i = 0; i < pageCount; i++) pages.push(bytes.slice(i * pageSize, (i + 1) * pageSize));
  return { rootKey, pages, pageSize, pageCount };
}

function readNames(db: SqliteDb): string[] {
  const stmt = db.prepare("SELECT name FROM t ORDER BY id;");
  const names: string[] = [];
  while (stmt.step()) names.push(stmt.columnText(0));
  stmt.finalize();
  return names;
}

function fakeClient(commit: RqliteHttpClient["commit"]): RqliteHttpClient {
  return { commit } as unknown as RqliteHttpClient;
}

describe("registerRemoteVfs", () => {
  it("opens and decrypts a real db from lazily-fetched pages, caching thereafter", async () => {
    const { rootKey, pages, pageSize, pageCount } = await buildRealDb();
    const fetchLog: number[] = [];
    const mod = await loadWasm();
    const backedPath = "/remote-vfs-read.db";
    const handle = registerRemoteVfs(mod, {
      pageSize,
      pageCount,
      currentVersion: 1,
      backedPath,
      fetchPage: (pageNo) => {
        fetchLog.push(pageNo);
        const page = pages[pageNo - 1];
        if (!page) throw new Error(`test fetchPage: no such page ${pageNo}`);
        return page;
      },
    });

    const db = await SqliteDb.open(backedPath, {
      vfsName: handle.name,
      rawKey: rootKey,
      readOnly: true,
    });
    try {
      expect(readNames(db)).toEqual(["hello", "world"]);
      const fetchesAfterFirstPass = fetchLog.length;
      expect(fetchesAfterFirstPass).toBeGreaterThan(0);
      expect(fetchesAfterFirstPass).toBeLessThanOrEqual(pageCount);

      expect(readNames(db)).toEqual(["hello", "world"]);
      expect(fetchLog.length).toBe(fetchesAfterFirstPass); // repeat query: no re-fetch

      expect(handle.stats.roundtrips.length).toBe(fetchLog.length);
      expect(handle.stats.bytesFetched).toBe(fetchLog.length * pageSize);
    } finally {
      db.close();
    }
  });

  it("keeps writes in memory until commit(), then posts exactly the dirty pages with old/new version", async () => {
    const { rootKey, pages, pageSize, pageCount } = await buildRealDb();
    const mod = await loadWasm();
    const backedPath = "/remote-vfs-write.db";
    const handle = registerRemoteVfs(mod, {
      pageSize,
      pageCount,
      currentVersion: 5,
      backedPath,
      fetchPage: (pageNo) => {
        const page = pages[pageNo - 1];
        if (!page) throw new Error(`test fetchPage: no such page ${pageNo}`);
        return page;
      },
    });
    expect(handle.isDirty()).toBe(false);

    const db = await SqliteDb.open(backedPath, { vfsName: handle.name, rawKey: rootKey });
    try {
      expect(readNames(db)).toEqual(["hello", "world"]);

      db.run("INSERT INTO t (name) VALUES (?);", (s) => s.bindText(1, "new-row"));
      expect(handle.isDirty()).toBe(true);

      let captured: {
        pages: CommitPage[];
        oldVersion: number;
        newVersion: number;
        pageCount: number;
      } | null = null;
      const client = fakeClient(async (pgs, oldVersion, newVersion, count) => {
        captured = { pages: pgs, oldVersion, newVersion, pageCount: count };
        return true;
      });

      const ok = await handle.commit(client);
      expect(ok).toBe(true);
      expect(handle.isDirty()).toBe(false);
      expect(captured).not.toBeNull();
      expect(captured!.oldVersion).toBe(5);
      expect(captured!.newVersion).toBe(6);
      expect(captured!.pages.length).toBeGreaterThan(0);
      expect(captured!.pageCount).toBeGreaterThanOrEqual(pageCount);
    } finally {
      db.close();
    }
  });

  it("commits only the pages a small write actually touched, not the whole database", async () => {
    // Builds a real db large enough to span many pages (a big TEXT blob
    // forces overflow pages), then makes one small, unrelated write and
    // confirms the commit's dirty-page set is a tiny fraction of the total
    // page count -- proving this is genuinely page-at-a-time, not a full
    // re-upload of the database on every commit.
    const rootKey = randomBytes(256);
    const path = `/remote-vfs-sparse-write-${buildCounter++}.db`;
    const db0 = await SqliteDb.open(path, { rawKey: rootKey });
    const pageSizeStmt = db0.prepare("PRAGMA page_size;");
    pageSizeStmt.step();
    const pageSize = Number(pageSizeStmt.columnInt64(0));
    pageSizeStmt.finalize();

    db0.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, blob TEXT);");
    const bigText = "x".repeat(500_000); // forces many overflow pages
    db0.run("INSERT INTO t (name, blob) VALUES (?, ?);", (s) => {
      s.bindText(1, "big-row");
      s.bindText(2, bigText);
    });
    db0.run("INSERT INTO t (name, blob) VALUES (?, ?);", (s) => {
      s.bindText(1, "small-row");
      s.bindText(2, "small");
    });
    db0.close();

    const mod = await loadWasm();
    const bytes = mod.FS.readFile(path);
    const pageCount = bytes.length / pageSize;
    const pages: Uint8Array[] = [];
    for (let i = 0; i < pageCount; i++) pages.push(bytes.slice(i * pageSize, (i + 1) * pageSize));
    expect(pageCount).toBeGreaterThan(20); // sanity: the big blob really did span many pages

    const backedPath = "/remote-vfs-sparse-write.db";
    const handle = registerRemoteVfs(mod, {
      pageSize,
      pageCount,
      currentVersion: 1,
      backedPath,
      fetchPage: (pageNo) => pages[pageNo - 1]!,
    });
    const db = await SqliteDb.open(backedPath, { vfsName: handle.name, rawKey: rootKey });
    try {
      // Touches only the tiny "small-row" -- nowhere near the big blob's
      // many overflow pages.
      db.run("UPDATE t SET name = 'renamed' WHERE name = 'small-row';");

      let dirtyCount = 0;
      const client = fakeClient(async (pgs) => {
        dirtyCount = pgs.length;
        return true;
      });
      await handle.commit(client);

      expect(dirtyCount).toBeGreaterThan(0);
      expect(dirtyCount).toBeLessThan(pageCount / 4); // a small fraction, not the whole db
    } finally {
      db.close();
    }
  });

  it("evicts least-recently-used pages once the cache exceeds the 250-page budget", async () => {
    // Builds a db with enough overflow-page-heavy rows to span well past
    // 250 physical pages, then reads every row's full content twice.
    // PRAGMA cache_size=1 keeps SQLite's own pager from shielding the
    // second pass -- without that, repeat page requests could be served
    // straight out of SQLite's internal pcache and this test would prove
    // nothing about *our* cache. With the pager defeated, the first pass
    // populates (and, past 250 pages, starts evicting from) our own
    // pageCache; the second pass must therefore re-fetch at least the
    // pages evicted during the first, but not literally every page (the
    // most-recently-touched ones are still resident).
    const rootKey = randomBytes(256);
    const path = `/remote-vfs-lru-${buildCounter++}.db`;
    const db0 = await SqliteDb.open(path, { rawKey: rootKey });
    const pageSizeStmt = db0.prepare("PRAGMA page_size;");
    pageSizeStmt.step();
    const pageSize = Number(pageSizeStmt.columnInt64(0));
    pageSizeStmt.finalize();

    db0.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT);");
    const padding = "x".repeat(pageSize * 2); // forces multiple overflow pages per row
    for (let i = 0; i < 300; i++) {
      db0.run("INSERT INTO t (blob) VALUES (?);", (s) => s.bindText(1, padding));
    }
    db0.close();

    const mod = await loadWasm();
    const bytes = mod.FS.readFile(path);
    const pageCount = bytes.length / pageSize;
    const pages: Uint8Array[] = [];
    for (let i = 0; i < pageCount; i++) pages.push(bytes.slice(i * pageSize, (i + 1) * pageSize));
    expect(pageCount).toBeGreaterThan(250); // sanity: the db really spans past the budget

    const fetchLog: number[] = [];
    const backedPath = "/remote-vfs-lru.db";
    const handle = registerRemoteVfs(mod, {
      pageSize,
      pageCount,
      currentVersion: 1,
      backedPath,
      fetchPage: (pageNo) => {
        fetchLog.push(pageNo);
        return pages[pageNo - 1]!;
      },
    });

    const db = await SqliteDb.open(backedPath, {
      vfsName: handle.name,
      rawKey: rootKey,
      readOnly: true,
    });
    try {
      db.exec("PRAGMA cache_size = 1;");

      const scanAllBlobs = () => {
        const stmt = db.prepare("SELECT blob FROM t;");
        let total = 0;
        while (stmt.step()) total += stmt.columnText(0).length;
        stmt.finalize();
        return total;
      };

      expect(scanAllBlobs()).toBe(300 * padding.length);
      const fetchesAfterFirstScan = fetchLog.length;
      expect(fetchesAfterFirstScan).toBeGreaterThan(250);

      // Don't re-run the full scan -- reading pages 1..640 in order again
      // slides the same 250-wide window across the same sequence with no
      // overlap, so it would (correctly, but uninterestingly) miss on
      // every single page. Instead point at two specific rows: the last
      // one inserted (whose overflow pages were the *last* ones the first
      // scan touched, so they're still within the 250-page window) versus
      // the first one inserted (whose overflow pages were the *first*
      // ones touched, long since evicted).
      const readBlob = (id: number) => {
        const stmt = db.prepare("SELECT blob FROM t WHERE id = ?;");
        stmt.bindInt64(1, id);
        stmt.step();
        const text = stmt.columnText(0);
        stmt.finalize();
        return text;
      };

      fetchLog.length = 0;
      expect(readBlob(300).length).toBe(padding.length);
      const fetchesForRecentRow = fetchLog.length;

      fetchLog.length = 0;
      expect(readBlob(1).length).toBe(padding.length);
      const fetchesForOldRow = fetchLog.length;

      // The recently-touched row's pages are still cached (at most a stale
      // root/interior page needs re-fetching); the long-evicted row's
      // pages are not.
      expect(fetchesForOldRow).toBeGreaterThan(fetchesForRecentRow);
    } finally {
      db.close();
    }
  });

  it("leaves dirty pages intact when commit's CAS is lost, so the caller can retry", async () => {
    const { rootKey, pages, pageSize, pageCount } = await buildRealDb();
    const mod = await loadWasm();
    const backedPath = "/remote-vfs-cas-lost.db";
    const handle = registerRemoteVfs(mod, {
      pageSize,
      pageCount,
      currentVersion: 1,
      backedPath,
      fetchPage: (pageNo) => pages[pageNo - 1]!,
    });

    const db = await SqliteDb.open(backedPath, { vfsName: handle.name, rawKey: rootKey });
    try {
      db.run("INSERT INTO t (name) VALUES (?);", (s) => s.bindText(1, "x"));
      expect(handle.isDirty()).toBe(true);

      const losingClient = fakeClient(async () => false);
      const ok = await handle.commit(losingClient);
      expect(ok).toBe(false);
      expect(handle.isDirty()).toBe(true); // still there -- caller must reopen and retry
    } finally {
      db.close();
    }
  });

  it("commit() with no dirty pages is a no-op that never calls the client", async () => {
    const { pages, pageSize, pageCount } = await buildRealDb();
    const mod = await loadWasm();
    const backedPath = "/remote-vfs-noop-commit.db";
    const handle = registerRemoteVfs(mod, {
      pageSize,
      pageCount,
      currentVersion: 1,
      backedPath,
      fetchPage: (pageNo) => pages[pageNo - 1]!,
    });

    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return true;
    });
    const ok = await handle.commit(client);
    expect(ok).toBe(true);
    expect(called).toBe(false);
  });
});
