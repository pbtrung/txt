// @vitest-environment jsdom
//
// Mocks DbWorkerClient entirely -- the real SqliteDb/VFS/commit wiring it
// wraps now lives inside dbWorker.ts's Worker (see that file's header
// comment for why), and is verified for real there (dbWorker.test.ts) and,
// end to end in a genuine browser, by smoke.e2e.test.ts. Also mocks
// firebaseAuth.signIn/instantClient.createInstantClient/session.resolveSession
// -- the real InstantDB/Firebase network calls -- so this file only needs to
// prove VaultContext.tsx's own React state management -- status/progress
// transitions, session shape, accessMap/bookmarksMap updates, error
// handling -- which doesn't need any of that for real.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64 } from "../crypto/bytes";

vi.mock("../data/dbWorkerClient", () => ({ DbWorkerClient: vi.fn() }));
vi.mock("../data/firebaseAuth", () => ({ signIn: vi.fn() }));
vi.mock("../data/instantClient", () => ({ createInstantClient: vi.fn() }));
vi.mock("../data/session", () => ({ resolveSession: vi.fn() }));

import { DbWorkerClient } from "../data/dbWorkerClient";
import * as firebaseAuth from "../data/firebaseAuth";
import { createInstantClient } from "../data/instantClient";
import { resolveSession } from "../data/session";
import { useVault, VaultProvider } from "./VaultContext";

interface FakeClient {
  open: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  loadLibrary: ReturnType<typeof vi.fn>;
  loadBookmarksMap: ReturnType<typeof vi.fn>;
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
        [
          1,
          {
            txtId: 1,
            name: "doc-one.txt",
            title: "doc-one.txt",
            subjects: [],
            rawMetadata: [],
          },
        ],
      ]),
      accessMap: new Map(),
    }),
    loadBookmarksMap: vi.fn().mockResolvedValue(new Map()),
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

function installFakeAuth() {
  vi.mocked(firebaseAuth.signIn).mockResolvedValue({
    auth: {} as never,
    idToken: "fake-id-token",
  });
  const instantDb = {
    auth: {
      signInWithIdToken: vi.fn().mockResolvedValue({
        user: { id: "auth-1", email: "admin@example.com" },
        created: false,
      }),
    },
  };
  vi.mocked(createInstantClient).mockReturnValue(instantDb as never);
  vi.mocked(resolveSession).mockResolvedValue({
    usersRowId: "users-row-1",
    dbMetaId: "dbmeta-1",
    currentVersion: 1,
    pageCount: 3,
    pageSize: 32768,
    pathKey: new Uint8Array(128),
    dbKey: new Uint8Array(256),
    r2Config: {
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "txt-parts",
      readOnlyAccessKeyId: "ro-id",
      readOnlySecretAccessKey: "ro-secret",
    },
  });
  return { instantDb };
}

function fakeFile(contents: unknown): File {
  return new File([JSON.stringify(contents)], "creds.json", {
    type: "application/json",
  });
}

function fakeCredsJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    firebase_email: "admin@example.com",
    firebase_password: "hunter2",
    firebase_api_key: "fake-api-key",
    firebase_auth_domain: "example.firebaseapp.com",
    firebase_project_id: "example",
    instant_app_id: "app-1",
    instant_client_name: "firebase",
    user_root_key: bytesToBase64(new Uint8Array(256)),
    ...overrides,
  };
}

function renderVault() {
  return renderHook(() => useVault(), { wrapper: VaultProvider });
}

async function unlockWith(overrides: Partial<FakeClient> = {}) {
  installFakeAuth();
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

    expect(result.current.session?.displayName).toBe("admin@example.com");
    expect(result.current.session?.metadataById.get(1)?.title).toBe(
      "doc-one.txt",
    );
    expect(result.current.accessMap.size).toBe(0);
    expect(result.current.bookmarksMap.size).toBe(0);
    expect(result.current.error).toBeNull();
    expect(client.open).toHaveBeenCalledWith({
      instantAppId: "app-1",
      instantClientName: "firebase",
      idToken: "fake-id-token",
      authId: "auth-1",
      ownerId: "users-row-1",
      dbMetaId: "dbmeta-1",
      currentVersion: 1,
      pageCount: 3,
      pageSize: 32768,
      r2Config: expect.objectContaining({ bucket: "txt-parts" }),
      pathKey: expect.any(Uint8Array),
      dbKey: expect.any(Uint8Array),
    });
  });

  it("prefers the creds file's own display_name over the signed-in email", async () => {
    installFakeAuth();
    installFakeClient();
    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(
        fakeFile(fakeCredsJson({ display_name: "Trung" })),
      );
    });
    await waitFor(() => expect(result.current.status).toBe("unlocked"));
    expect(result.current.session?.displayName).toBe("Trung");
  });

  it("reports an error, terminates the client, and stays locked when open() fails", async () => {
    installFakeAuth();
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

  it("recordReadPosition delegates to the client and updates accessMap", async () => {
    const { result, client } = await unlockWith();

    await act(async () => {
      await result.current.recordReadPosition(1, {
        lastPartNum: 3,
        lastAccessedMs: 5000,
      });
    });

    expect(result.current.accessMap.get(1)).toEqual({
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });
    expect(client.recordReadPosition).toHaveBeenCalledWith(1, {
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });
  });

  it("removeAccessEntry delegates to the client and clears the read position from accessMap", async () => {
    const { result, client } = await unlockWith();

    await act(async () => {
      await result.current.recordReadPosition(1, {
        lastPartNum: 3,
        lastAccessedMs: 5000,
      });
      await result.current.removeAccessEntry(1);
    });

    expect(result.current.accessMap.has(1)).toBe(false);
    expect(client.removeAccessEntry).toHaveBeenCalledWith(1);
  });

  it("addBookmarkEntry / removeBookmarkEntry delegate to the client and adopt the returned bookmarksMap", async () => {
    const bookmarksAfterAdd = new Map([
      [
        1,
        [
          {
            id: 5,
            txtId: 1,
            partNum: 0,
            line: 5,
            preview: "first line",
            createdAt: 1000,
          },
        ],
      ],
    ]);
    const { result, client } = await unlockWith({
      addBookmarkEntry: vi.fn().mockResolvedValue(bookmarksAfterAdd),
      removeBookmarkEntry: vi.fn().mockResolvedValue(new Map()),
    });

    await act(async () => {
      await result.current.addBookmarkEntry(1, 0, 5, "first line");
    });
    expect(result.current.bookmarksMap).toBe(bookmarksAfterAdd);
    expect(client.addBookmarkEntry).toHaveBeenCalledWith(
      1,
      0,
      5,
      "first line",
      expect.any(Number),
    );

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
          new Error(
            "Another session updated this vault. Please reload and try again.",
          ),
        ),
    });

    await expect(
      act(async () => {
        await result.current.recordReadPosition(1, {
          lastPartNum: 1,
          lastAccessedMs: 1,
        });
      }),
    ).rejects.toThrow("Another session updated this vault");
  });

  it("refresh() calls the client's refresh then reloads library/bookmarks", async () => {
    const { result, client } = await unlockWith();

    client.loadLibrary.mockResolvedValue({
      metadataById: new Map([
        [
          1,
          {
            txtId: 1,
            name: "doc-one.txt",
            title: "doc-one.txt",
            subjects: [],
            rawMetadata: [],
          },
        ],
        [
          2,
          {
            txtId: 2,
            name: "doc-two.txt",
            title: "doc-two.txt",
            subjects: [],
            rawMetadata: [],
          },
        ],
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
