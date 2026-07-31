// @vitest-environment jsdom
//
// Mocks DbWorkerClient entirely -- the real SqliteDb/VFS/commit wiring it
// wraps now lives inside dbWorker.ts's Worker (see that file's header
// comment for why), and is verified for real there (dbWorker.test.ts) and,
// end to end in a genuine browser, by smoke.e2e.test.ts. This file only
// needs to prove VaultContext.tsx's own React state management -- status/
// progress transitions, session shape, accessMap/bookmarksMap updates,
// error handling -- which doesn't need a real Worker at all.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64 } from "../crypto/bytes";

vi.mock("../data/dbWorkerClient", () => ({ DbWorkerClient: vi.fn() }));
vi.mock("../data/r2", () => ({ createR2Client: vi.fn(() => ({})) }));

import { DbWorkerClient } from "../data/dbWorkerClient";
import { useVault, VaultProvider } from "./VaultContext";

interface FakeClient {
  open: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  loadLibrary: ReturnType<typeof vi.fn>;
  loadBookmarksMap: ReturnType<typeof vi.fn>;
  getTxtKey: ReturnType<typeof vi.fn>;
  getR2Config: ReturnType<typeof vi.fn>;
  getVfsStats: ReturnType<typeof vi.fn>;
  recordReadPosition: ReturnType<typeof vi.fn>;
  removeAccessEntry: ReturnType<typeof vi.fn>;
  addBookmarkEntry: ReturnType<typeof vi.fn>;
  removeBookmarkEntry: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    loadLibrary: vi.fn().mockResolvedValue({
      metadataById: new Map([
        [1, { txtId: 1, name: "doc-one.txt", title: "doc-one.txt", subjects: [], rawMetadata: [] }],
      ]),
      accessMap: new Map(),
    }),
    loadBookmarksMap: vi.fn().mockResolvedValue(new Map()),
    getTxtKey: vi.fn().mockResolvedValue(new Uint8Array([0])),
    getR2Config: vi.fn().mockResolvedValue({
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "txt-parts",
      readOnlyAccessKeyId: "ro-id",
      readOnlySecretAccessKey: "ro-secret",
    }),
    getVfsStats: vi.fn().mockResolvedValue({ roundtrips: [], bytesFetched: 0 }),
    recordReadPosition: vi.fn().mockResolvedValue(undefined),
    removeAccessEntry: vi.fn().mockResolvedValue(undefined),
    addBookmarkEntry: vi.fn().mockResolvedValue(new Map()),
    removeBookmarkEntry: vi.fn().mockResolvedValue(new Map()),
    terminate: vi.fn(),
    ...overrides,
  };
}

function installFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const client = fakeClient(overrides);
  vi.mocked(DbWorkerClient).mockImplementation(function (this: unknown) {
    return client as unknown as DbWorkerClient;
  } as unknown as typeof DbWorkerClient);
  return client;
}

function fakeFile(contents: unknown): File {
  return new File([JSON.stringify(contents)], "creds.json", { type: "application/json" });
}

function fakeCredsJson(): Record<string, unknown> {
  return {
    rqlite_url: "https://rqlite.example.com",
    api_key: "test-api-key",
    user_root_key: bytesToBase64(new Uint8Array(256)),
  };
}

function renderVault() {
  return renderHook(() => useVault(), { wrapper: VaultProvider });
}

async function unlockWith(overrides: Partial<FakeClient> = {}) {
  const client = installFakeClient(overrides);
  const { result } = renderVault();
  await act(async () => {
    await result.current.unlock(fakeFile(fakeCredsJson()));
  });
  await waitFor(() => expect(result.current.status).toBe("unlocked"));
  return { result, client };
}

describe("VaultProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unlocks successfully and loads metadataById/accessMap/bookmarksMap via the worker client", async () => {
    const { result, client } = await unlockWith();

    expect(result.current.session?.creds.rqliteUrl).toBe("https://rqlite.example.com");
    expect(result.current.session?.metadataById.get(1)?.title).toBe("doc-one.txt");
    expect(result.current.accessMap.size).toBe(0);
    expect(result.current.bookmarksMap.size).toBe(0);
    expect(result.current.error).toBeNull();
    expect(client.open).toHaveBeenCalledWith({
      rqliteUrl: "https://rqlite.example.com",
      apiKey: "test-api-key",
      userRootKey: expect.any(Uint8Array),
    });
  });

  it("reports an error, terminates the client, and stays locked when open() fails", async () => {
    const client = installFakeClient({
      open: vi.fn().mockRejectedValue(new Error("network down")),
    });

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(fakeCredsJson()));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.error).toContain("network down");
    expect(result.current.session).toBeNull();
    expect(client.terminate).toHaveBeenCalledOnce();
  });

  it("reports a friendly error for a malformed creds file", async () => {
    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(new File(["not json"], "creds.json"));
    });
    expect(result.current.status).toBe("locked");
    expect(result.current.error).toBeTruthy();
  });

  it("lock() terminates the client and clears session/maps", async () => {
    const { result, client } = await unlockWith();

    act(() => result.current.lock());

    expect(result.current.status).toBe("locked");
    expect(result.current.session).toBeNull();
    expect(result.current.accessMap.size).toBe(0);
    expect(client.terminate).toHaveBeenCalledOnce();
  });

  it("getTxtKey delegates to the client and caches the result thereafter", async () => {
    const { result, client } = await unlockWith();

    let key: Uint8Array | undefined;
    await act(async () => {
      key = await result.current.getTxtKey(1);
    });
    expect(key).toEqual(new Uint8Array([0]));
    expect(client.getTxtKey).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.getTxtKey(1); // second call: served from cache
    });
    expect(client.getTxtKey).toHaveBeenCalledOnce(); // still once -- no re-call
  });

  it("recordReadPosition delegates to the client and updates accessMap", async () => {
    const { result, client } = await unlockWith();

    await act(async () => {
      await result.current.recordReadPosition(1, { lastPartNum: 3, lastAccessedMs: 5000 });
    });

    expect(result.current.accessMap.get(1)).toEqual({ lastPartNum: 3, lastAccessedMs: 5000 });
    expect(client.recordReadPosition).toHaveBeenCalledWith(1, {
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });
  });

  it("removeAccessEntry delegates to the client and clears the read position from accessMap", async () => {
    const { result, client } = await unlockWith();

    await act(async () => {
      await result.current.recordReadPosition(1, { lastPartNum: 3, lastAccessedMs: 5000 });
      await result.current.removeAccessEntry(1);
    });

    expect(result.current.accessMap.has(1)).toBe(false);
    expect(client.removeAccessEntry).toHaveBeenCalledWith(1);
  });

  it("addBookmarkEntry / removeBookmarkEntry delegate to the client and adopt the returned bookmarksMap", async () => {
    const bookmarksAfterAdd = new Map([
      [1, [{ id: 5, txtId: 1, partNum: 0, line: 5, preview: "first line", createdAt: 1000 }]],
    ]);
    const { result, client } = await unlockWith({
      addBookmarkEntry: vi.fn().mockResolvedValue(bookmarksAfterAdd),
      removeBookmarkEntry: vi.fn().mockResolvedValue(new Map()),
    });

    await act(async () => {
      await result.current.addBookmarkEntry(1, 0, 5, "first line");
    });
    expect(result.current.bookmarksMap).toBe(bookmarksAfterAdd);
    expect(client.addBookmarkEntry).toHaveBeenCalledWith(1, 0, 5, "first line", expect.any(Number));

    await act(async () => {
      await result.current.removeBookmarkEntry(5);
    });
    expect(result.current.bookmarksMap.size).toBe(0);
    expect(client.removeBookmarkEntry).toHaveBeenCalledWith(5);
  });

  it("surfaces a rejection from the client's recordReadPosition as a thrown error", async () => {
    const { result } = await unlockWith({
      recordReadPosition: vi
        .fn()
        .mockRejectedValue(
          new Error("Another session updated this vault. Please reload and try again."),
        ),
    });

    await expect(
      act(async () => {
        await result.current.recordReadPosition(1, { lastPartNum: 1, lastAccessedMs: 1 });
      }),
    ).rejects.toThrow("Another session updated this vault");
  });

  it("refresh() calls the client's refresh then reloads library/bookmarks", async () => {
    const { result, client } = await unlockWith();

    client.loadLibrary.mockResolvedValue({
      metadataById: new Map([
        [1, { txtId: 1, name: "doc-one.txt", title: "doc-one.txt", subjects: [], rawMetadata: [] }],
        [2, { txtId: 2, name: "doc-two.txt", title: "doc-two.txt", subjects: [], rawMetadata: [] }],
      ]),
      accessMap: new Map(),
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(client.refresh).toHaveBeenCalledOnce();
    expect(result.current.session?.metadataById.size).toBe(2);
    expect(result.current.refreshing).toBe(false);
  });
});
