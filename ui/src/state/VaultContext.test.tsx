// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVault, VaultProvider } from "./VaultContext";

vi.mock("../data/db", () => ({ createDb: vi.fn(() => ({ execute: vi.fn() })) }));
vi.mock("../data/r2", () => ({ createR2Client: vi.fn(() => ({ fetch: vi.fn() })), deleteObject: vi.fn() }));
vi.mock("../data/owner", () => ({
  resolveUserAndCheckPassword: vi.fn(),
  unwrapUmk: vi.fn(),
  unwrapPrivKey: vi.fn(),
  unwrapTxtKey: vi.fn(),
  fetchR2Config: vi.fn(),
  partRawPaths: vi.fn(),
}));
vi.mock("../data/adminUsers", () => ({ resolveUserUmk: vi.fn() }));
vi.mock("../data/metadata", () => ({
  loadTxtMetadata: vi.fn(),
  saveBookMetadata: vi.fn(),
  removeTxtMetadataEntry: vi.fn(),
}));
vi.mock("../data/access", () => ({
  loadOrInitAccess: vi.fn(),
  setReadPosition: vi.fn(),
  removeAccessEntry: vi.fn(),
}));
vi.mock("../data/bookmarks", () => ({
  loadOrInitBookmarks: vi.fn(),
  addBookmark: vi.fn(),
  removeBookmark: vi.fn(),
  removeAllBookmarksForTxt: vi.fn(),
}));
vi.mock("../data/adminTxt", () => ({ deleteTxtRows: vi.fn() }));
vi.mock("../data/adminShares", () => ({ shareRecipientIds: vi.fn() }));

import * as accessData from "../data/access";
import type { AccessMap } from "../data/access";
import * as adminShares from "../data/adminShares";
import * as adminTxt from "../data/adminTxt";
import * as adminUsers from "../data/adminUsers";
import * as bookmarksData from "../data/bookmarks";
import * as metadata from "../data/metadata";
import type { BookInfo } from "../data/metadata";
import * as owner from "../data/owner";
import * as r2 from "../data/r2";

/** Wires up the three post-auth loads (metadata/access/bookmarks) that
 * unlock() now performs, so a successful-unlock test doesn't need to spell
 * this out every time. */
function mockLibraryLoads() {
  vi.mocked(metadata.loadTxtMetadata).mockResolvedValue({ state: null, metadataById: new Map() });
  vi.mocked(accessData.loadOrInitAccess).mockResolvedValue({ txtAccessKey: new Uint8Array(64), accessMap: new Map() });
  vi.mocked(bookmarksData.loadOrInitBookmarks).mockResolvedValue({
    bookmarkKey: new Uint8Array(64),
    bookmarksMap: new Map(),
  });
}

const CONFIG = {
  turso_database_url: "libsql://example",
  turso_auth_token: "token",
  username: "alice",
  username_lookup_key: btoa("x".repeat(32)),
  password: "hunter2",
  display_name: "Alice",
  user_root_key: btoa("x".repeat(256)),
};

function fakeFile(contents: unknown): File {
  return new File([JSON.stringify(contents)], "config.json", { type: "application/json" });
}

function renderVault() {
  return renderHook(() => useVault(), { wrapper: VaultProvider });
}

describe("VaultProvider", () => {
  // verbose logging defaults to on (see src/log.ts) -- unlock() logs each of
  // its steps unconditionally, so silence that rather than let it clutter
  // every test run's output.
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unlocks successfully when every step succeeds", async () => {
    vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: true });
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.unwrapPrivKey).mockResolvedValue(new Uint8Array(64).fill(2));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    mockLibraryLoads();

    const { result } = renderVault();
    expect(result.current.status).toBe("locked");

    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });

    await waitFor(() => expect(result.current.status).toBe("unlocked"));
    expect(result.current.session?.userId).toBe(42);
    expect(result.current.session?.creds.displayName).toBe("Alice");
    expect(result.current.error).toBeNull();
  });

  it("moves progress through each unlock phase, then clears it", async () => {
    let resolveAuth: (auth: { userId: number; passwordOk: boolean }) => void = () => {};
    vi.mocked(owner.resolveUserAndCheckPassword).mockReturnValue(
      new Promise((resolve) => {
        resolveAuth = resolve;
      }),
    );
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.unwrapPrivKey).mockResolvedValue(new Uint8Array(64).fill(2));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    mockLibraryLoads();

    const { result } = renderVault();
    expect(result.current.progress).toBeNull();

    let unlockPromise: Promise<void> = Promise.resolve();
    act(() => {
      unlockPromise = result.current.unlock(fakeFile(CONFIG));
    });
    // "Signing you in" covers resolveUserAndCheckPassword -- stalled on it,
    // so this is where progress should sit until it resolves.
    await waitFor(() => expect(result.current.progress).toEqual({ label: "Signing you in", step: 1, total: 5 }));

    await act(async () => {
      resolveAuth({ userId: 42, passwordOk: true });
      await unlockPromise;
    });

    expect(result.current.status).toBe("unlocked");
    expect(result.current.progress).toBeNull();
  });

  it("splits the library-loading phase into its three actual requests, not one big step", async () => {
    vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: true });
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.unwrapPrivKey).mockResolvedValue(new Uint8Array(64).fill(2));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    vi.mocked(metadata.loadTxtMetadata).mockResolvedValue({ state: null, metadataById: new Map() });
    let resolveAccess: (value: { txtAccessKey: Uint8Array; accessMap: AccessMap }) => void = () => {};
    vi.mocked(accessData.loadOrInitAccess).mockReturnValue(
      new Promise((resolve) => {
        resolveAccess = resolve;
      }),
    );
    vi.mocked(bookmarksData.loadOrInitBookmarks).mockResolvedValue({
      bookmarkKey: new Uint8Array(64),
      bookmarksMap: new Map(),
    });

    const { result } = renderVault();
    let unlockPromise: Promise<void> = Promise.resolve();
    act(() => {
      unlockPromise = result.current.unlock(fakeFile(CONFIG));
    });
    // Stalled on loadOrInitAccess -- if the whole library load were still
    // one "Loading your library" step, this would still show the
    // metadata step's own label, not its own phase.
    await waitFor(() =>
      expect(result.current.progress).toEqual({ label: "Loading your read progress", step: 4, total: 5 }),
    );

    await act(async () => {
      resolveAccess({ txtAccessKey: new Uint8Array(64), accessMap: new Map() });
      await unlockPromise;
    });
    expect(result.current.status).toBe("unlocked");
  });

  it("clears progress if unlock fails", async () => {
    vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: false });

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.progress).toBeNull();
  });

  it("stays locked and reports an error for an invalid config file", async () => {
    const { result } = renderVault();

    await act(async () => {
      await result.current.unlock(fakeFile({ not: "a valid config" }));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.session).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it("stays locked when the password check fails", async () => {
    vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: false });

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.error).toMatch(/incorrect password/i);
  });

  it("serializes concurrent bookmark additions so neither overwrites the other", async () => {
    vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: true });
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.unwrapPrivKey).mockResolvedValue(new Uint8Array(64).fill(2));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    mockLibraryLoads();

    // A faithful-enough stand-in for the real addBookmark (bookmarks.ts):
    // read-modify-write off whatever map it's handed.
    let createdAt = 0;
    vi.mocked(bookmarksData.addBookmark).mockImplementation(
      async (_db, _userId, _key, currentMap, txtId, partNum, line, txtPreview) => {
        const next = new Map(currentMap);
        next.set(txtId, [...(next.get(txtId) ?? []), { partNum, line, txtPreview, createdAt: ++createdAt }]);
        return next;
      },
    );

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });
    await waitFor(() => expect(result.current.status).toBe("unlocked"));

    // Fired back to back, neither awaited before the other starts -- exactly
    // the "two rapid-fire calls" scenario accessMapRef/bookmarksMapRef exist
    // to handle. Without serializing through enqueueMutation, both would read
    // the same pre-mutation bookmarksMap and one addition would silently
    // overwrite the other.
    await act(async () => {
      await Promise.all([
        result.current.addBookmarkEntry(1, 1, 1, "first"),
        result.current.addBookmarkEntry(1, 1, 2, "second"),
      ]);
    });

    expect(result.current.bookmarksMap.get(1)).toHaveLength(2);
  });

  it("deleteTxt removes the txt's rows, access/bookmarks entries, and its in-memory metadata", async () => {
    vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: true });
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.unwrapPrivKey).mockResolvedValue(new Uint8Array(64).fill(2));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    const bookInfo = { txtId: 7, name: "book.txt", title: "Book", subjects: [], rawMetadata: [] } as BookInfo;
    vi.mocked(metadata.loadTxtMetadata).mockResolvedValue({ state: null, metadataById: new Map([[7, bookInfo]]) });
    vi.mocked(accessData.loadOrInitAccess).mockResolvedValue({
      txtAccessKey: new Uint8Array(64),
      accessMap: new Map([[7, { lastPartNum: 1, lastAccessedMs: 100 }]]),
    });
    vi.mocked(bookmarksData.loadOrInitBookmarks).mockResolvedValue({
      bookmarkKey: new Uint8Array(64),
      bookmarksMap: new Map(),
    });
    vi.mocked(adminTxt.deleteTxtRows).mockResolvedValue(undefined);
    vi.mocked(adminShares.shareRecipientIds).mockResolvedValue([]);
    vi.mocked(owner.unwrapTxtKey).mockResolvedValue(new Uint8Array(64).fill(9));
    vi.mocked(owner.partRawPaths).mockResolvedValue(["path-1", "path-2"]);
    vi.mocked(r2.deleteObject).mockResolvedValue(undefined);
    vi.mocked(metadata.removeTxtMetadataEntry).mockResolvedValue(null);
    vi.mocked(accessData.removeAccessEntry).mockImplementation(async (_db, _userId, _key, currentMap, txtId) => {
      const next = new Map(currentMap);
      next.delete(txtId);
      return next;
    });
    vi.mocked(bookmarksData.removeAllBookmarksForTxt).mockResolvedValue(new Map());

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });
    await waitFor(() => expect(result.current.status).toBe("unlocked"));
    expect(result.current.session?.metadataById.has(7)).toBe(true);

    await act(async () => {
      await result.current.deleteTxt(7);
    });

    expect(owner.partRawPaths).toHaveBeenCalledWith(expect.anything(), 7, expect.any(Uint8Array));
    expect(r2.deleteObject).toHaveBeenCalledTimes(2);
    expect(r2.deleteObject).toHaveBeenCalledWith(expect.anything(), expect.anything(), "path-1");
    expect(r2.deleteObject).toHaveBeenCalledWith(expect.anything(), expect.anything(), "path-2");
    expect(adminTxt.deleteTxtRows).toHaveBeenCalledWith(expect.anything(), 7);
    expect(metadata.removeTxtMetadataEntry).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      7,
      undefined,
      null,
    );
    expect(accessData.removeAccessEntry).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.anything(),
      expect.anything(),
      7,
    );
    expect(bookmarksData.removeAllBookmarksForTxt).toHaveBeenCalledWith(
      expect.anything(),
      42,
      expect.anything(),
      expect.anything(),
      7,
    );
    expect(result.current.accessMap.has(7)).toBe(false);
    expect(result.current.session?.metadataById.has(7)).toBe(false);
  });

  it("deleteTxt best-effort scrubs each recipient's copied metadata entry before deleting the txt_shares rows", async () => {
    vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: true });
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    mockLibraryLoads();
    vi.mocked(adminTxt.deleteTxtRows).mockResolvedValue(undefined);
    vi.mocked(owner.unwrapTxtKey).mockResolvedValue(new Uint8Array(64).fill(9));
    vi.mocked(owner.partRawPaths).mockResolvedValue([]);
    vi.mocked(r2.deleteObject).mockResolvedValue(undefined);
    vi.mocked(accessData.removeAccessEntry).mockResolvedValue(new Map());
    vi.mocked(bookmarksData.removeAllBookmarksForTxt).mockResolvedValue(new Map());

    // Two recipients: one whose umk resolves fine, one whose escrow lookup
    // fails outright -- the cleanup must still proceed for the first and
    // never block the delete itself for the second.
    vi.mocked(adminShares.shareRecipientIds).mockResolvedValue([2, 3]);
    vi.mocked(adminUsers.resolveUserUmk).mockImplementation(async (_db, _adminUmk, userId) => {
      if (userId === 2) return new Uint8Array(64).fill(5);
      throw new Error("boom");
    });
    vi.mocked(metadata.removeTxtMetadataEntry).mockResolvedValue(null);

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });
    await waitFor(() => expect(result.current.status).toBe("unlocked"));

    await act(async () => {
      await result.current.deleteTxt(7);
    });

    expect(adminShares.shareRecipientIds).toHaveBeenCalledWith(expect.anything(), 7);
    // Recipient #2's copy is scrubbed with their own (resolved) umk...
    expect(metadata.removeTxtMetadataEntry).toHaveBeenCalledWith(
      expect.anything(),
      2,
      expect.any(Uint8Array),
      expect.anything(),
      expect.anything(),
      7,
    );
    // ...recipient #3's escrow lookup threw, so no removal call was ever
    // made for them -- but that must not have stopped deleteTxtRows.
    expect(metadata.removeTxtMetadataEntry).not.toHaveBeenCalledWith(
      expect.anything(),
      3,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      7,
    );
    expect(adminTxt.deleteTxtRows).toHaveBeenCalledWith(expect.anything(), 7);

    // Cleanup runs before the txt_shares rows (and the txt itself) are gone.
    const cleanupCallOrder = vi.mocked(adminShares.shareRecipientIds).mock.invocationCallOrder[0];
    const deleteRowsCallOrder = vi.mocked(adminTxt.deleteTxtRows).mock.invocationCallOrder[0];
    expect(cleanupCallOrder).toBeLessThan(deleteRowsCallOrder);
  });

  it("deleteTxt throws when the vault is locked", async () => {
    const { result } = renderVault();
    await expect(result.current.deleteTxt(7)).rejects.toThrow("vault is locked");
  });

  it("lock() clears the session and returns to locked", async () => {
    vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: true });
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.unwrapPrivKey).mockResolvedValue(new Uint8Array(64).fill(2));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    mockLibraryLoads();

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });
    await waitFor(() => expect(result.current.status).toBe("unlocked"));

    act(() => result.current.lock());

    expect(result.current.status).toBe("locked");
    expect(result.current.session).toBeNull();
  });

  describe("refresh", () => {
    async function unlockedResult() {
      vi.mocked(owner.resolveUserAndCheckPassword).mockResolvedValue({ userId: 42, passwordOk: true });
      vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.unwrapPrivKey).mockResolvedValue(new Uint8Array(64).fill(2));
      vi.mocked(owner.fetchR2Config).mockResolvedValue({
        endpoint: "https://x",
        region: "auto",
        bucket: "b",
        readOnlyAccessKeyId: "id",
        readOnlySecretAccessKey: "secret",
      });
      mockLibraryLoads();

      const { result } = renderVault();
      await act(async () => {
        await result.current.unlock(fakeFile(CONFIG));
      });
      await waitFor(() => expect(result.current.status).toBe("unlocked"));
      return result;
    }

    it("re-loads metadata, access, and bookmarks", async () => {
      const result = await unlockedResult();
      expect(result.current.session?.metadataById.size).toBe(0);
      expect(result.current.accessMap.size).toBe(0);
      expect(result.current.bookmarksMap.size).toBe(0);

      const freshMetadata = new Map([[7, { txtId: 7 } as unknown as BookInfo]]);
      vi.mocked(metadata.loadTxtMetadata).mockResolvedValue({ state: null, metadataById: freshMetadata });
      vi.mocked(accessData.loadOrInitAccess).mockResolvedValue({
        txtAccessKey: new Uint8Array(64),
        accessMap: new Map([[7, { lastPartNum: 3, lastAccessedMs: 1 }]]),
      });
      vi.mocked(bookmarksData.loadOrInitBookmarks).mockResolvedValue({
        bookmarkKey: new Uint8Array(64),
        bookmarksMap: new Map([[7, [{ partNum: 3, line: 1, txtPreview: "x", createdAt: 1 }]]]),
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.session?.metadataById).toBe(freshMetadata);
      expect(result.current.accessMap.get(7)).toEqual({ lastPartNum: 3, lastAccessedMs: 1 });
      expect(result.current.bookmarksMap.get(7)).toHaveLength(1);
    });

    it("toggles refreshing on for the duration of the call", async () => {
      const result = await unlockedResult();
      expect(result.current.refreshing).toBe(false);

      let resolveMetadata: (value: metadata.LoadedTxtMetadata) => void = () => {};
      vi.mocked(metadata.loadTxtMetadata).mockReturnValue(
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
      );

      let refreshPromise: Promise<void> = Promise.resolve();
      act(() => {
        refreshPromise = result.current.refresh();
      });
      await waitFor(() => expect(result.current.refreshing).toBe(true));

      await act(async () => {
        resolveMetadata({ state: null, metadataById: new Map() });
        await refreshPromise;
      });
      expect(result.current.refreshing).toBe(false);
    });

    it("moves progress through each refresh phase, then clears it", async () => {
      const result = await unlockedResult();
      expect(result.current.progress).toBeNull();

      let resolveAccess: (value: { txtAccessKey: Uint8Array; accessMap: AccessMap }) => void = () => {};
      vi.mocked(accessData.loadOrInitAccess).mockReturnValue(
        new Promise((resolve) => {
          resolveAccess = resolve;
        }),
      );

      let refreshPromise: Promise<void> = Promise.resolve();
      act(() => {
        refreshPromise = result.current.refresh();
      });
      await waitFor(() =>
        expect(result.current.progress).toEqual({ label: "Loading your read progress", step: 2, total: 3 }),
      );

      await act(async () => {
        resolveAccess({ txtAccessKey: new Uint8Array(64), accessMap: new Map() });
        await refreshPromise;
      });
      expect(result.current.progress).toBeNull();
    });

    it("throws when the vault is locked", async () => {
      const { result } = renderVault();
      await expect(result.current.refresh()).rejects.toThrow(/locked/i);
    });
  });
});
