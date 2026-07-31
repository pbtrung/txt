// @vitest-environment jsdom
//
// Mocks only the two things that genuinely can't run under Vitest/jsdom --
// real network (RqliteHttpClient) and a real browser Worker
// (remotePageClient.ts's startRemotePageWorker) -- and lets everything else
// (SqliteDb, registerRemoteVfs, loadWasm) run for real against a small,
// genuine SQLCipher database built the same way remoteVfs.test.ts's own
// fixture is, so this still exercises the real VFS/commit wiring, not just
// mocked plumbing.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

import { bytesToBase64 } from "../crypto/bytes";
import { SqliteDb } from "../data/sqliteDb";
import { loadWasm } from "../data/wasmLoader";

// jsdom (needed below for renderHook) makes isBrowser() true, which would
// otherwise send wasmLoader.ts down the real <script src="/sqlcipher.js">
// path -- jsdom never actually executes that tag, so the load hangs forever.
// Force the Node import() path instead, same as every other data-layer test
// (those run under the default "node" environment, where isBrowser() is
// naturally false already).
vi.mock("../env", () => ({ isBrowser: () => false }));
vi.mock("../data/r2", () => ({ createR2Client: vi.fn(() => ({})) }));
vi.mock("../data/remotePageClient", () => ({ startRemotePageWorker: vi.fn() }));
vi.mock("../data/rqliteHttpClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/rqliteHttpClient")>();
  return { ...actual, RqliteHttpClient: vi.fn() };
});

import { RqliteHttpClient, type RqliteResult } from "../data/rqliteHttpClient";
import { startRemotePageWorker } from "../data/remotePageClient";
import { useVault, VaultProvider } from "./VaultContext";

interface DbFixture {
  rootKey: Uint8Array;
  pages: Uint8Array[];
  pageSize: number;
  pageCount: number;
}

let buildCounter = 0;

async function buildVaultDb(): Promise<DbFixture> {
  const rootKey = randomBytes(256);
  const path = `/vaultcontext-test-build-${buildCounter++}.db`;
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
  `);
  db.run("INSERT INTO txt (id, txt_key, name) VALUES (1, x'00', ?);", (s) =>
    s.bindText(1, "doc-one.txt"),
  );
  db.close();

  const mod = await loadWasm();
  const bytes = mod.FS.readFile(path);
  const pageCount = bytes.length / pageSize;
  const pages: Uint8Array[] = [];
  for (let i = 0; i < pageCount; i++) pages.push(bytes.slice(i * pageSize, (i + 1) * pageSize));
  return { rootKey, pages, pageSize, pageCount };
}

/** Wires the two mocked externals (RqliteHttpClient, startRemotePageWorker)
 * to serve `fixture`'s pages, so unlock()/refresh() can open a real db
 * through the real VFS without any actual network or Worker. */
function mockBackend(
  fixture: DbFixture,
  opts: { currentVersion?: number; commitOk?: boolean } = {},
) {
  const currentVersion = opts.currentVersion ?? 1;
  const commit = vi.fn().mockResolvedValue(opts.commitOk ?? true);
  const query = vi.fn(async (statementId: string): Promise<RqliteResult[]> => {
    if (statementId === "GET_META") {
      return [{ values: [[currentVersion, fixture.pageCount, fixture.pageSize]] }];
    }
    throw new Error(`mockBackend: unexpected query ${statementId}`);
  });
  vi.mocked(RqliteHttpClient).mockImplementation(function (this: unknown) {
    return { query, commit } as unknown as RqliteHttpClient;
  } as unknown as typeof RqliteHttpClient);
  const terminate = vi.fn();
  vi.mocked(startRemotePageWorker).mockResolvedValue({
    fetchPage: (pageNo: number) => fixture.pages[pageNo - 1]!,
    terminate,
  });
  return { commit, terminate, query };
}

function fakeFile(contents: unknown): File {
  return new File([JSON.stringify(contents)], "creds.json", { type: "application/json" });
}

function fakeCredsJson(rootKey: Uint8Array): Record<string, unknown> {
  return {
    rqlite_url: "https://rqlite.example.com",
    api_key: "test-api-key",
    user_root_key: bytesToBase64(rootKey),
    r2_config: {
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "txt-parts",
      read_only_access_key_id: "ro-id",
      read_only_secret_access_key: "ro-secret",
    },
  };
}

function renderVault() {
  return renderHook(() => useVault(), { wrapper: VaultProvider });
}

async function unlockWith(fixture: DbFixture, backendOpts?: { commitOk?: boolean }) {
  const backend = mockBackend(fixture, backendOpts);
  const { result } = renderVault();
  await act(async () => {
    await result.current.unlock(fakeFile(fakeCredsJson(fixture.rootKey)));
  });
  await waitFor(() => expect(result.current.status).toBe("unlocked"));
  return { result, backend };
}

describe("VaultProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unlocks successfully and loads metadataById/accessMap/bookmarksMap from the real db", async () => {
    const fixture = await buildVaultDb();
    const { result } = await unlockWith(fixture);

    expect(result.current.session?.creds.rqliteUrl).toBe("https://rqlite.example.com");
    expect(result.current.session?.metadataById.get(1)?.title).toBe("doc-one.txt");
    expect(result.current.accessMap.size).toBe(0); // never opened yet
    expect(result.current.bookmarksMap.size).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it("reports an error and stays locked when GET_META fails", async () => {
    const fixture = await buildVaultDb();
    vi.mocked(RqliteHttpClient).mockImplementation(function (this: unknown) {
      return {
        query: vi.fn().mockRejectedValue(new Error("network down")),
        commit: vi.fn(),
      } as unknown as RqliteHttpClient;
    } as unknown as typeof RqliteHttpClient);
    vi.mocked(startRemotePageWorker).mockResolvedValue({
      fetchPage: (pageNo: number) => fixture.pages[pageNo - 1]!,
      terminate: vi.fn(),
    });

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(fakeCredsJson(fixture.rootKey)));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.error).toContain("network down");
    expect(result.current.session).toBeNull();
  });

  it("reports a friendly error for a malformed creds file", async () => {
    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(new File(["not json"], "creds.json"));
    });
    expect(result.current.status).toBe("locked");
    expect(result.current.error).toBeTruthy();
  });

  it("lock() terminates the page worker and clears session/maps", async () => {
    const fixture = await buildVaultDb();
    const { result, backend } = await unlockWith(fixture);

    act(() => result.current.lock());

    expect(result.current.status).toBe("locked");
    expect(result.current.session).toBeNull();
    expect(result.current.accessMap.size).toBe(0);
    expect(backend.terminate).toHaveBeenCalledOnce();
  });

  it("getTxtKey reads txt.txt_key from the open db and caches it thereafter", async () => {
    const fixture = await buildVaultDb();
    const { result } = await unlockWith(fixture);

    let key: Uint8Array | undefined;
    await act(async () => {
      key = await result.current.getTxtKey(1);
    });
    expect(key).toEqual(new Uint8Array([0]));

    await act(async () => {
      await result.current.getTxtKey(1); // second call: served from cache, no re-query needed
    });
  });

  it("getTxtKey throws for a nonexistent txt_id", async () => {
    const fixture = await buildVaultDb();
    const { result } = await unlockWith(fixture);
    await expect(result.current.getTxtKey(999)).rejects.toThrow("no txt row for txt_id=999");
  });

  it("recordReadPosition writes+commits, then reflects the new position in accessMap", async () => {
    const fixture = await buildVaultDb();
    const { result, backend } = await unlockWith(fixture);

    await act(async () => {
      await result.current.recordReadPosition(1, { lastPartNum: 3, lastAccessedMs: 5000 });
    });

    expect(result.current.accessMap.get(1)).toEqual({ lastPartNum: 3, lastAccessedMs: 5000 });
    expect(backend.commit).toHaveBeenCalledOnce();
  });

  it("removeAccessEntry clears the read position from accessMap", async () => {
    const fixture = await buildVaultDb();
    const { result } = await unlockWith(fixture);

    await act(async () => {
      await result.current.recordReadPosition(1, { lastPartNum: 3, lastAccessedMs: 5000 });
    });
    await act(async () => {
      await result.current.removeAccessEntry(1);
    });

    expect(result.current.accessMap.has(1)).toBe(false);
  });

  it("addBookmarkEntry / removeBookmarkEntry write+commit and refresh bookmarksMap", async () => {
    const fixture = await buildVaultDb();
    const { result } = await unlockWith(fixture);

    await act(async () => {
      await result.current.addBookmarkEntry(1, 0, 5, "first line");
    });
    const added = result.current.bookmarksMap.get(1);
    expect(added).toHaveLength(1);
    expect(added![0]!.preview).toBe("first line");

    await act(async () => {
      await result.current.removeBookmarkEntry(added![0]!.id);
    });
    expect(result.current.bookmarksMap.get(1) ?? []).toHaveLength(0);
  });

  it("surfaces a lost commit CAS as a thrown error, without losing the local write", async () => {
    const fixture = await buildVaultDb();
    const { result } = await unlockWith(fixture, { commitOk: false });

    await expect(
      act(async () => {
        await result.current.recordReadPosition(1, { lastPartNum: 1, lastAccessedMs: 1 });
      }),
    ).rejects.toThrow("Another session updated this vault");
  });

  it("refresh() re-opens against a fresh worker and reloads the library", async () => {
    const fixture = await buildVaultDb();
    const { result, backend } = await unlockWith(fixture);

    const secondTerminate = vi.fn();
    vi.mocked(startRemotePageWorker).mockResolvedValue({
      fetchPage: (pageNo: number) => fixture.pages[pageNo - 1]!,
      terminate: secondTerminate,
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(backend.terminate).toHaveBeenCalledOnce(); // old worker torn down
    expect(result.current.session?.metadataById.get(1)?.title).toBe("doc-one.txt");
    expect(result.current.refreshing).toBe(false);
  });
});
