// Exercises dbWorker.ts's real logic directly (bypassing the self.onmessage/
// postMessage wiring entirely, which needs an actual Worker environment
// Node/jsdom don't provide) against a real SQLCipher db built the same way
// remoteVfs.test.ts's own fixture is. Mocks the things that genuinely can't
// run here -- a real InstantDB session (init()), real R2 (aws4fetch), and a
// real browser Worker (remotePageClient.ts's startRemotePageWorker) -- so
// this still proves the real VFS/commit/prefetch/lease wiring works, not
// just mocked plumbing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import * as blob from "../crypto/blob";
import { computeR2Prefix } from "./pagePointer";
import { SqliteDb } from "./sqliteDb";
import { loadWasm } from "./wasmLoader";

vi.mock("./remotePageClient", () => ({ startRemotePageWorker: vi.fn() }));
vi.mock("@instantdb/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@instantdb/react")>();
  return { ...actual, init: vi.fn() };
});
vi.mock("./r2", () => ({
  getObject: vi.fn(),
  putObject: vi.fn(),
}));

import { init } from "@instantdb/react";
import { startRemotePageWorker } from "./remotePageClient";
import { getObject, putObject } from "./r2";
import * as dbWorker from "./dbWorker";
import type { OpenParams } from "./dbWorker";

interface DbFixture {
  dbKey: Uint8Array;
  pages: Uint8Array[];
  pageSize: number;
  pageCount: number;
}

let buildCounter = 0;

async function buildVaultDb(): Promise<DbFixture> {
  const dbKey = randomBytes(256);
  const path = `/dbworker-test-build-${buildCounter++}.db`;
  const db = await SqliteDb.open(path, { rawKey: dbKey });
  const pageSizeStmt = db.prepare("PRAGMA page_size;");
  pageSizeStmt.step();
  const pageSize = Number(pageSizeStmt.columnInt64(0));
  pageSizeStmt.finalize();

  db.exec(`
    CREATE TABLE txt (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      metadata BLOB, last_part_num INTEGER, last_accessed INTEGER
    );
    CREATE TABLE txt_parts (
      id INTEGER PRIMARY KEY, txt_id INTEGER NOT NULL, part_num INTEGER NOT NULL,
      content BLOB NOT NULL UNIQUE
    );
    CREATE TABLE txt_bookmarks (
      id INTEGER PRIMARY KEY, txt_id INTEGER NOT NULL, part_num INTEGER NOT NULL,
      line INTEGER NOT NULL, preview TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (txt_id, part_num, line)
    );
  `);
  db.run("INSERT INTO txt (id, name) VALUES (1, ?);", (s) =>
    s.bindText(1, "doc-one.txt"),
  );
  db.run(
    "INSERT INTO txt_parts (txt_id, part_num, content) VALUES (1, 0, ?);",
    (s) => s.bindBlob(1, new TextEncoder().encode("part-0")),
  );
  db.close();

  const mod = await loadWasm();
  const bytes = mod.FS.readFile(path);
  const pageCount = bytes.length / pageSize;
  const pages: Uint8Array[] = [];
  for (let i = 0; i < pageCount; i++)
    pages.push(bytes.slice(i * pageSize, (i + 1) * pageSize));
  return { dbKey, pages, pageSize, pageCount };
}

const r2Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-bucket",
};

const pathKey = new Uint8Array(128).fill(4);
const authId = "auth-1";
const ownerId = "users-row-1";
const dbMetaId = "dbmeta-1";

// A stateful fake InstantDB client (queryOnce/transact/storage.uploadFile)
// -- same shape/reducer as instantPageStore.test.ts's fakeInstantDb, plus
// activeReaders support for the reader-lease tests here. r2 GET/PUT are
// backed by a plain in-memory Map (r2.ts is mocked wholesale in this file),
// keyed by rawPath ("${computeR2Prefix(authId)}/${rawKey}") -- only rawKey
// is ever what gets encrypted into $files' content, same as the real
// instantPageStore.ts.
function mockBackend(
  fixture: DbFixture,
  opts: { currentVersion?: number; commitShouldFail?: boolean } = {},
) {
  const currentVersion = opts.currentVersion ?? 1;
  const r2Store = new Map<string, Uint8Array>();
  const store = {
    pages: new Map<string, any>(),
    $files: new Map<string, any>(),
    dbMeta: new Map<string, any>([
      [
        dbMetaId,
        {
          id: dbMetaId,
          currentVersion,
          pageCount: fixture.pageCount,
          pageSize: fixture.pageSize,
        },
      ],
    ]),
    activeReaders: new Map<string, any>(),
  };
  // Seed every fixture page as an already-committed $files/pages pair at
  // currentVersion, so open()'s own prefetch (instantPageStore.fetchPage)
  // can resolve them for real, exercising the same code path a live vault
  // would.
  let fileCounter = 0;
  for (let pageNo = 1; pageNo <= fixture.pageCount; pageNo++) {
    const rawKey = `page-${pageNo}`;
    const rawPath = `${computeR2Prefix(authId)}/${rawKey}`;
    r2Store.set(rawPath, fixture.pages[pageNo - 1]!);
    fileCounter++;
    const fileId = `file-${fileCounter}`;
    store.$files.set(fileId, { id: fileId, owner: ownerId, rawKey });
    store.pages.set(`page-${pageNo}`, {
      id: `page-${pageNo}`,
      owner: ownerId,
      pageNo,
      version: currentVersion,
      pointerFile: fileId,
    });
  }

  vi.mocked(getObject).mockImplementation(
    async (_client, _config, key) => r2Store.get(key) ?? new Uint8Array(0),
  );
  vi.mocked(putObject).mockImplementation(
    async (_client, _config, key, body) => {
      r2Store.set(key, body);
    },
  );

  const fakeDb = {
    auth: { signInWithIdToken: vi.fn().mockResolvedValue({}) },
    transact: vi.fn(async (txs: any[]) => {
      if (opts.commitShouldFail) {
        throw new Error("Permission denied: dbMeta CAS check failed");
      }
      for (const t of txs) {
        const coll = (store as any)[t.__etype];
        for (const [op, , id, data] of t.__ops) {
          if (op === "delete") {
            coll.delete(id);
            continue;
          }
          const row = coll.get(id) ?? { id };
          Object.assign(row, data);
          coll.set(id, row);
        }
      }
      return { "tx-id": "fake-tx" };
    }),
    storage: {
      uploadFile: vi.fn(async (path: string, content: Blob) => {
        fileCounter++;
        const id = `file-${fileCounter}`;
        const rawKeyBlob = new Uint8Array(await content.arrayBuffer());
        const rawKey = new TextDecoder().decode(
          await blob.decrypt(pathKey, rawKeyBlob, false),
        );
        const rawPath = `${computeR2Prefix(authId)}/${rawKey}`;
        r2Store.set(rawPath, new Uint8Array(0)); // placeholder; putObject fills real bytes
        store.$files.set(id, { id, path, owner: undefined, rawKey });
        return { data: { id } };
      }),
    },
    // Supports both fetchPage's single-pageNo query (order by version desc,
    // limit 1) and fetchPagesBatch's own pageNo: {$in: [...]} + order by
    // pageKey asc + cursor pagination -- real queryOnce() resolves with
    // {data: {...}, pageInfo: {...}} as *siblings* (confirmed against
    // @instantdb/core's own queryOnce() type), pageInfo never nested inside
    // data, so this mirrors that exactly rather than the shape it's easy to
    // assume.
    queryOnce: vi.fn(async (q: any) => {
      if (q.pages) {
        const { where, order, limit, after } = q.pages.$;
        let rows = [...store.pages.values()].filter((r) => {
          if (r.owner !== where["owner.id"]) return false;
          if (where.pageNo !== undefined) {
            if (
              typeof where.pageNo === "object" &&
              where.pageNo !== null &&
              "$in" in where.pageNo
            ) {
              if (!where.pageNo.$in.includes(r.pageNo)) return false;
            } else if (r.pageNo !== where.pageNo) {
              return false;
            }
          }
          if (
            where.version?.$lte !== undefined &&
            r.version > where.version.$lte
          ) {
            return false;
          }
          return true;
        });
        const paginated = order?.pageKey === "asc";
        if (paginated) {
          rows.sort((a, b) =>
            a.pageKey < b.pageKey ? -1 : a.pageKey > b.pageKey ? 1 : 0,
          );
        } else if (order?.version) {
          rows.sort((a, b) =>
            order.version === "desc"
              ? b.version - a.version
              : a.version - b.version,
          );
        }
        if (after !== undefined) rows = rows.filter((r) => r.pageKey > after);
        const hasNextPage = limit !== undefined && rows.length > limit;
        if (limit !== undefined) rows = rows.slice(0, limit);
        const endCursor =
          rows.length > 0 ? rows[rows.length - 1].pageKey : after;
        const mapped = rows.map((r) => {
          const file = store.$files.get(r.pointerFile);
          return {
            ...r,
            pointerFile: file
              ? [
                  {
                    url: `instant-file://${file.id}`,
                    rawKey: file.rawKey,
                  },
                ]
              : [],
          };
        });
        return {
          data: { pages: mapped },
          pageInfo: paginated
            ? { pages: { hasNextPage, endCursor } }
            : undefined,
        };
      }
      if (q.dbMeta) {
        const row = store.dbMeta.get(q.dbMeta.$.where.id);
        return { data: { dbMeta: row ? [row] : [] } };
      }
      throw new Error(`mockBackend: unhandled query ${JSON.stringify(q)}`);
    }),
  };

  // fetch() is used by instantPageStore.ts's downloadPointerContent to fetch
  // $files.url -- stub it to resolve straight from the fake $files store by
  // its rawKey (encrypted the same way a real upload would have -- never the
  // full rawPath, since r2Prefix is re-derived from authId at read time).
  // Also stubs tempR2Creds.ts's own POST /api/r2-creds call (worker/r2Creds.ts
  // isn't reachable from this test environment) with a fake-but-well-shaped
  // temporary credential, so dbWorker.ts's open()/refreshR2Credential() exercise
  // their real fetchTempR2Credential() call, just against a fake response.
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/r2-creds") {
      return new Response(
        JSON.stringify({
          accessKeyId: "temp-access-key",
          secretAccessKey: "temp-secret-key",
          sessionToken: "temp-session-token",
          expiresAtMs: Date.now() + 900_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const fileId = url.replace("instant-file://", "");
    const file = [...store.$files.values()].find((f) => f.id === fileId);
    if (!file) return new Response(null, { status: 404 });
    const content = await blob.encrypt(
      pathKey,
      new TextEncoder().encode(file.rawKey),
    );
    return new Response(content as BodyInit, { status: 200 });
  });

  vi.mocked(init).mockReturnValue(fakeDb as never);
  const terminate = vi.fn();
  const fetchPage = vi.fn((pageNo: number) => fixture.pages[pageNo - 1]!);
  const updateSnapshot = vi.fn();
  vi.mocked(startRemotePageWorker).mockResolvedValue({
    fetchPage,
    updateSnapshot,
    terminate,
  });

  return {
    fakeDb,
    store,
    terminate,
    fetchPage,
    updateSnapshot,
    restoreFetch: () => vi.stubGlobal("fetch", realFetch),
  };
}

function openParamsFor(fixture: DbFixture, currentVersion = 1): OpenParams {
  return {
    instantAppId: "app-1",
    instantClientName: "firebase",
    idToken: "fake-id-token",
    authId,
    ownerId,
    dbMetaId,
    currentVersion,
    pageCount: fixture.pageCount,
    pageSize: fixture.pageSize,
    r2Config,
    pathKey,
    dbKey: fixture.dbKey,
  };
}

async function openWith(
  fixture: DbFixture,
  opts?: { currentVersion?: number; commitShouldFail?: boolean },
) {
  const backend = mockBackend(fixture, opts);
  await dbWorker.open(openParamsFor(fixture, opts?.currentVersion));
  return backend;
}

describe("dbWorker", () => {
  afterEach(async () => {
    await dbWorker.close();
    vi.unstubAllGlobals();
  });

  // Must run before any other test calls open(): storedOpenParams (unlike
  // db/vfs/pageStoreCfg/pageWorker) deliberately survives close() so a real
  // refresh() after a close+reopen cycle still has params to reuse -- which
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

  it("open() registers an activeReaders lease, pinned to the opened snapshot", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);

    const readers = [...backend.store.activeReaders.values()];
    expect(readers).toHaveLength(1);
    expect(readers[0].snapshotVersion).toBe(1);
    expect(readers[0].owner).toBe(ownerId);
  });

  it("commitOrThrow renews the reader lease to the just-committed version", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);

    await dbWorker.recordReadPosition(1, {
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });

    const readers = [...backend.store.activeReaders.values()];
    expect(readers[0].snapshotVersion).toBe(2); // old_version 1 -> new_version 2
  });

  it("close() releases the reader lease", async () => {
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);

    await dbWorker.close();

    expect(backend.store.activeReaders.size).toBe(0);
  });

  it("methods throw 'vault is locked' before open()", async () => {
    expect(() => dbWorker.partCount(1)).toThrow("vault is locked");
  });

  it("partCount/partContent read real txt_parts rows", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);
    expect(dbWorker.partCount(1)).toBe(1);
    expect(dbWorker.partContent(1, 0)).toEqual(
      new TextEncoder().encode("part-0"),
    );
    expect(dbWorker.partContent(1, 99)).toBeNull();
  });

  it("recordReadPosition writes+commits for real, reflected in a fresh loadLibrary()", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);

    await dbWorker.recordReadPosition(1, {
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });

    const { accessMap } = await dbWorker.loadLibraryHandler();
    expect(accessMap.get(1)).toEqual({ lastPartNum: 3, lastAccessedMs: 5000 });
  });

  it("commitOrThrow advances pageWorker's pinned snapshot after a successful commit", async () => {
    // Regression test: pageWorker's own fetch snapshot used to stay frozen
    // at whatever open() saw, so a live fetch (a cache miss, or a page
    // evicted from the LRU cache) for a page only written by this or an
    // earlier commit this session would come back "not found" against that
    // stale snapshot -- see remotePageClient.ts's updateSnapshot.
    const fixture = await buildVaultDb();
    const backend = await openWith(fixture);

    await dbWorker.recordReadPosition(1, {
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });

    expect(backend.updateSnapshot).toHaveBeenCalledWith(2); // old_version 1 -> new_version 2
  });

  it("removeAccessEntry clears the read position for real", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);
    await dbWorker.recordReadPosition(1, {
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });
    await dbWorker.removeAccessEntry(1);
    const { accessMap } = await dbWorker.loadLibraryHandler();
    expect(accessMap.has(1)).toBe(false);
  });

  it("addBookmarkEntry/removeBookmarkEntry write+commit and return the updated map", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);

    const afterAdd = await dbWorker.addBookmarkEntry(
      1,
      0,
      5,
      "first line",
      Date.now(),
    );
    const added = afterAdd.get(1);
    expect(added).toHaveLength(1);
    expect(added![0]!.preview).toBe("first line");

    const afterRemove = await dbWorker.removeBookmarkEntry(added![0]!.id);
    expect(afterRemove.get(1) ?? []).toHaveLength(0);
  });

  it("getVfsStats/fetchVfsStats reads the real remoteVfs.ts stats object", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture);

    // The whole fixture gets covered by open()'s own prefetch (it's far
    // smaller than PREFETCH_PAGE_LIMIT), which bypasses getPage()/stats
    // tracking entirely via primeCache() -- so a fresh open() has nothing to
    // report yet. This proves the RPC plumbing reaches the real vfs.stats
    // object, not that it's ever nonzero (remoteVfs.test.ts already covers
    // getPage()'s own stats bookkeeping directly).
    const stats = dbWorker.fetchVfsStats();
    expect(stats.roundtrips).toEqual([]);
    expect(stats.bytesFetched).toBe(0);
  });

  it("surfaces exhausted CAS retries as a thrown error", async () => {
    const fixture = await buildVaultDb();
    await openWith(fixture, { commitShouldFail: true });
    await expect(
      dbWorker.recordReadPosition(1, { lastPartNum: 1, lastAccessedMs: 1 }),
    ).rejects.toThrow("CAS check failed");
  });

  it("refresh() re-opens against a fresh worker using the params from open()", async () => {
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
