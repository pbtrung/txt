// Exercises dbWorker.ts's real logic directly (bypassing the self.onmessage/
// postMessage wiring entirely, which needs an actual Worker environment
// Node/jsdom don't provide) against a real SQLCipher db built the same way
// remoteVfs.test.ts's own fixture is. Mocks only the two things that
// genuinely can't run here -- real network (RqliteHttpClient) and a real
// browser Worker (remotePageClient.ts's startRemotePageWorker) -- so this
// still proves the real VFS/commit wiring works, not just mocked plumbing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { bytesToBase64 } from "../crypto/bytes";
import { SqliteDb } from "./sqliteDb";
import { loadWasm } from "./wasmLoader";

vi.mock("./remotePageClient", () => ({ startRemotePageWorker: vi.fn() }));
vi.mock("./rqliteHttpClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rqliteHttpClient")>();
  return { ...actual, RqliteHttpClient: vi.fn() };
});

import { RqliteHttpClient } from "./rqliteHttpClient";
import { startRemotePageWorker } from "./remotePageClient";
import * as dbWorker from "./dbWorker";

interface DbFixture {
  rootKey: Uint8Array;
  pages: Uint8Array[];
  pageSize: number;
  pageCount: number;
}

let buildCounter = 0;

async function buildVaultDb(
  opts: {
    r2Config?: {
      readWriteAccessKeyId: string | null;
      readWriteSecretAccessKey: string | null;
    };
  } = {},
): Promise<DbFixture> {
  const rootKey = randomBytes(256);
  const path = `/dbworker-test-build-${buildCounter++}.db`;
  const db = await SqliteDb.open(path, { rawKey: rootKey });
  const pageSizeStmt = db.prepare("PRAGMA page_size;");
  pageSizeStmt.step();
  const pageSize = Number(pageSizeStmt.columnInt64(0));
  pageSizeStmt.finalize();

  db.exec(`
    CREATE TABLE txt (
      id INTEGER PRIMARY KEY, txt_key BLOB NOT NULL, name TEXT NOT NULL,
      metadata BLOB, last_part_num INTEGER, last_accessed INTEGER
    );
    CREATE TABLE txt_parts (
      id INTEGER PRIMARY KEY, txt_id INTEGER NOT NULL, part_num INTEGER NOT NULL,
      path TEXT NOT NULL UNIQUE
    );
    CREATE TABLE txt_bookmarks (
      id INTEGER PRIMARY KEY, txt_id INTEGER NOT NULL, part_num INTEGER NOT NULL,
      line INTEGER NOT NULL, preview TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (txt_id, part_num, line)
    );
    CREATE TABLE r2_config (
      id INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      endpoint TEXT NOT NULL, region TEXT NOT NULL, bucket TEXT NOT NULL,
      read_only_access_key_id TEXT NOT NULL, read_only_secret_access_key TEXT NOT NULL,
      read_write_access_key_id TEXT, read_write_secret_access_key TEXT
    );
  `);
  db.run("INSERT INTO txt (id, txt_key, name) VALUES (1, x'00', ?);", (s) =>
    s.bindText(1, "doc-one.txt"),
  );
  db.run("INSERT INTO txt_parts (txt_id, part_num, path) VALUES (1, 0, 'path-0');");
  if (opts.r2Config) {
    db.run(
      `INSERT INTO r2_config (
         id, endpoint, region, bucket, read_only_access_key_id, read_only_secret_access_key,
         read_write_access_key_id, read_write_secret_access_key
       ) VALUES (1, 'https://r2.example.com', 'auto', 'txt-bucket', 'ro-id', 'ro-secret', ?, ?);`,
      (s) => {
        if (opts.r2Config!.readWriteAccessKeyId === null) s.bindNull(1);
        else s.bindText(1, opts.r2Config!.readWriteAccessKeyId);
        if (opts.r2Config!.readWriteSecretAccessKey === null) s.bindNull(2);
        else s.bindText(2, opts.r2Config!.readWriteSecretAccessKey);
      },
    );
  }
  db.close();

  const mod = await loadWasm();
  const bytes = mod.FS.readFile(path);
  const pageCount = bytes.length / pageSize;
  const pages: Uint8Array[] = [];
  for (let i = 0; i < pageCount; i++) pages.push(bytes.slice(i * pageSize, (i + 1) * pageSize));
  return { rootKey, pages, pageSize, pageCount };
}

function mockBackend(
  fixture: DbFixture,
  opts: { currentVersion?: number; commitOk?: boolean; adminUserId?: string } = {},
) {
  const currentVersion = opts.currentVersion ?? 1;
  const commit = vi.fn().mockResolvedValue(opts.commitOk ?? true);
  const query = vi.fn(async (statementId: string, batch: { page_no: number }[]) => {
    if (statementId === "RAW_QUERY") {
      // Mirrors auth_perms.lua: RAW_QUERY is admin-only, so a non-admin key
      // fails here the same way any unrecognized statementId would --
      // resolveTargetDbId's own try/catch turns that into "undefined".
      if (!opts.adminUserId) throw new Error("mockBackend: RAW_QUERY requires admin role");
      return [{ values: [[opts.adminUserId]] }];
    }
    if (statementId === "GET_META") {
      return [{ values: [[currentVersion, fixture.pageCount, fixture.pageSize]] }];
    }
    if (statementId === "READ_PAGE") {
      // open()'s own batched prefetchPages() call, not startRemotePageWorker
      // (mocked separately below) -- mirrors rqlite's real batch semantics,
      // one result entry per batch item, in order.
      return batch.map(({ page_no }) => {
        const page = fixture.pages[page_no - 1];
        return page ? { values: [[bytesToBase64(page)]] } : { values: [] };
      });
    }
    throw new Error(`mockBackend: unexpected query ${statementId}`);
  });
  const execute = vi.fn(async (statementId: string) => {
    if (statementId === "BEGIN_READ" || statementId === "END_READ") {
      return [{ rows_affected: 1 }];
    }
    throw new Error(`mockBackend: unexpected execute ${statementId}`);
  });
  vi.mocked(RqliteHttpClient).mockImplementation(function (this: unknown) {
    return { query, execute, commit } as unknown as RqliteHttpClient;
  } as unknown as typeof RqliteHttpClient);
  const terminate = vi.fn();
  const fetchPage = vi.fn((pageNo: number) => fixture.pages[pageNo - 1]!);
  const updateSnapshot = vi.fn();
  vi.mocked(startRemotePageWorker).mockResolvedValue({ fetchPage, updateSnapshot, terminate });
  return { commit, terminate, query, execute, fetchPage, updateSnapshot };
}

async function openWith(fixture: DbFixture, opts?: { commitOk?: boolean }) {
  const backend = mockBackend(fixture, opts);
  await dbWorker.open({
    rqliteUrl: "https://rqlite.example.com",
    apiKey: "test-key",
    userRootKey: fixture.rootKey,
  });
  return backend;
}

describe("dbWorker", () => {
  afterEach(async () => {
    await dbWorker.close();
  });

  // Must run before any other test calls open(): storedCreds (unlike
  // db/vfs/rqliteClient/pageWorker) deliberately survives close() so a real
  // refresh() after a close+reopen cycle still has creds to reuse -- which
  // means it also survives across tests in this same module instance unless
  // this specific "never opened at all" case runs first.
  it("refresh() before any open() throws 'vault is locked'", async () => {
    await expect(dbWorker.refresh()).rejects.toThrow("vault is locked");
  });

  it("open() opens the real db and loadLibrary()/loadBookmarksMap() read real data", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);

    const { metadataById, accessMap } = await dbWorker.loadLibraryHandler();
    expect(metadataById.get(1)?.title).toBe("doc-one.txt");
    expect(accessMap.size).toBe(0);

    const bookmarksMap = dbWorker.loadBookmarksMapHandler();
    expect(bookmarksMap.size).toBe(0);
  });

  it("open() registers an active_readers lease via BEGIN_READ, pinned to the opened snapshot", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture); // mockBackend defaults currentVersion to 1

    expect(backend.execute).toHaveBeenCalledWith(
      "BEGIN_READ",
      [
        expect.objectContaining({
          reader_id: expect.any(String),
          snapshot_version: 1,
          lease_expires_at: expect.any(Number),
        }),
      ],
      {},
    );
  });

  it("commitOrThrow renews the reader lease to the just-committed version", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);
    backend.execute.mockClear(); // drop open()'s own initial BEGIN_READ call

    await dbWorker.recordReadPosition(1, { lastPartNum: 3, lastAccessedMs: 5000 });

    expect(backend.execute).toHaveBeenCalledWith(
      "BEGIN_READ",
      [expect.objectContaining({ snapshot_version: 2 })], // old_version 1 -> new_version 2
      {},
    );
  });

  it("close() releases the reader lease via END_READ", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);
    backend.execute.mockClear();

    await dbWorker.close();

    expect(backend.execute).toHaveBeenCalledWith(
      "END_READ",
      [{ reader_id: expect.any(String) }],
      {},
    );
  });

  it("methods throw 'vault is locked' before open()", async () => {
    expect(() => dbWorker.partCount(1)).toThrow("vault is locked");
  });

  it("open() prefetches every page via batched READ_PAGE, so loadLibrary()/getTxtKey() never hit the per-page fetch path", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);

    // The prefetch itself goes through the mocked RqliteHttpClient's query()
    // (READ_PAGE, batched) -- not startRemotePageWorker's fetchPage, which
    // stands in for the one-page-at-a-time round trip this whole feature
    // exists to avoid.
    expect(backend.query).toHaveBeenCalledWith(
      "READ_PAGE",
      expect.arrayContaining([expect.objectContaining({ page_no: 1 })]),
      {},
    );

    await dbWorker.loadLibraryHandler();
    dbWorker.loadBookmarksMapHandler();
    dbWorker.fetchTxtKey(1);

    expect(backend.fetchPage).not.toHaveBeenCalled();
  });

  it("getTxtKey/fetchTxtKey reads txt.txt_key from the real db", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);
    expect(dbWorker.fetchTxtKey(1)).toEqual(new Uint8Array([0]));
    expect(() => dbWorker.fetchTxtKey(999)).toThrow("no txt row for txt_id=999");
  });

  it("partCount/partRawPath read real txt_parts rows", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);
    expect(dbWorker.partCount(1)).toBe(1);
    expect(dbWorker.partRawPath(1, 0)).toBe("path-0");
    expect(dbWorker.partRawPath(1, 99)).toBeNull();
  });

  it("recordReadPosition writes+commits for real, reflected in a fresh loadLibrary()", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);

    await dbWorker.recordReadPosition(1, { lastPartNum: 3, lastAccessedMs: 5000 });

    expect(backend.commit).toHaveBeenCalledOnce();
    const { accessMap } = await dbWorker.loadLibraryHandler();
    expect(accessMap.get(1)).toEqual({ lastPartNum: 3, lastAccessedMs: 5000 });
  });

  it("commitOrThrow advances pageWorker's pinned snapshot after a successful commit", async () => {
    // Regression test: pageWorker's own READ_PAGE snapshot used to stay
    // frozen at whatever open() saw, so a live fetch (a cache miss, or a
    // page evicted from the LRU cache) for a page only written by this or
    // an earlier commit this session would come back "not found" against
    // that stale snapshot -- see remotePageClient.ts's updateSnapshot.
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture); // mockBackend defaults currentVersion to 1

    await dbWorker.recordReadPosition(1, { lastPartNum: 3, lastAccessedMs: 5000 });

    expect(backend.updateSnapshot).toHaveBeenCalledWith(2); // old_version 1 -> new_version 2
  });

  it("removeAccessEntry clears the read position for real", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);
    await dbWorker.recordReadPosition(1, { lastPartNum: 3, lastAccessedMs: 5000 });
    await dbWorker.removeAccessEntry(1);
    const { accessMap } = await dbWorker.loadLibraryHandler();
    expect(accessMap.has(1)).toBe(false);
  });

  it("addBookmarkEntry/removeBookmarkEntry write+commit and return the updated map", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);

    const afterAdd = await dbWorker.addBookmarkEntry(1, 0, 5, "first line", Date.now());
    const added = afterAdd.get(1);
    expect(added).toHaveLength(1);
    expect(added![0]!.preview).toBe("first line");

    const afterRemove = await dbWorker.removeBookmarkEntry(added![0]!.id);
    expect(afterRemove.get(1) ?? []).toHaveLength(0);
  });

  it("getVfsStats/fetchVfsStats reads the real remoteVfs.ts stats object", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);

    // The whole fixture gets covered by open()'s own batched prefetch (it's
    // far smaller than MAX_CACHED_PAGES), which bypasses getPage()/stats
    // tracking entirely via primeCache() -- so a fresh open() has nothing to
    // report yet. This proves the RPC plumbing reaches the real vfs.stats
    // object, not that it's ever nonzero (remoteVfs.test.ts already covers
    // getPage()'s own stats bookkeeping directly).
    const stats = dbWorker.fetchVfsStats();
    expect(stats.roundtrips).toEqual([]);
    expect(stats.bytesFetched).toBe(0);
  });

  it("surfaces a lost commit CAS as a thrown error", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture, { commitOk: false });
    await expect(
      dbWorker.recordReadPosition(1, { lastPartNum: 1, lastAccessedMs: 1 }),
    ).rejects.toThrow("Another session updated this vault");
  });

  it("resolves target_db_id for an admin-role key and threads it through GET_META/READ_PAGE/COMMIT", async () => {
    const fixture = await buildVaultDb();
    const backend = mockBackend(fixture, { adminUserId: "admin-user-id" });
    await dbWorker.open({
      rqliteUrl: "https://rqlite.example.com",
      apiKey: "test-key",
      userRootKey: fixture.rootKey,
    });

    expect(backend.query).toHaveBeenCalledWith("GET_META", [{}], {
      target_db_id: "admin-user-id",
    });
    expect(startRemotePageWorker).toHaveBeenCalledWith(
      "https://rqlite.example.com",
      "test-key",
      fixture.pageSize,
      1,
      "admin-user-id",
    );

    await dbWorker.recordReadPosition(1, { lastPartNum: 1, lastAccessedMs: 1 });
    expect(backend.commit).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      "admin-user-id",
    );
  });

  it("getR2Config/fetchR2Config reads r2_config's row, mapping NULL read_write_* to undefined", async () => {
    const fixture = await buildVaultDb({
      r2Config: { readWriteAccessKeyId: null, readWriteSecretAccessKey: null },
    });
    await openWith(fixture);

    expect(dbWorker.fetchR2Config()).toEqual({
      endpoint: "https://r2.example.com",
      region: "auto",
      bucket: "txt-bucket",
      readOnlyAccessKeyId: "ro-id",
      readOnlySecretAccessKey: "ro-secret",
      readWriteAccessKeyId: undefined,
      readWriteSecretAccessKey: undefined,
    });
  });

  it("fetchR2Config reads the admin's populated read_write_* pair when present", async () => {
    const fixture = await buildVaultDb({
      r2Config: { readWriteAccessKeyId: "rw-id", readWriteSecretAccessKey: "rw-secret" },
    });
    await openWith(fixture);

    expect(dbWorker.fetchR2Config()).toEqual({
      endpoint: "https://r2.example.com",
      region: "auto",
      bucket: "txt-bucket",
      readOnlyAccessKeyId: "ro-id",
      readOnlySecretAccessKey: "ro-secret",
      readWriteAccessKeyId: "rw-id",
      readWriteSecretAccessKey: "rw-secret",
    });
  });

  it("fetchR2Config throws when no r2_config row exists yet", async () => {
    const fixture = await buildVaultDb(); // no r2Config seeded
    await openWith(fixture);
    expect(() => dbWorker.fetchR2Config()).toThrow("no r2_config row for this account");
  });

  it("refresh() re-opens against a fresh worker using the creds from open()", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);

    const secondTerminate = vi.fn();
    vi.mocked(startRemotePageWorker).mockResolvedValue({
      fetchPage: (pageNo: number) => fixture.pages[pageNo - 1]!,
      updateSnapshot: vi.fn(),
      terminate: secondTerminate,
    });

    await dbWorker.refresh();

    expect(backend.terminate).toHaveBeenCalledOnce(); // old worker torn down
    const { metadataById } = await dbWorker.loadLibraryHandler();
    expect(metadataById.get(1)?.title).toBe("doc-one.txt");
  });
});
