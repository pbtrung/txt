// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVault, VaultProvider } from "./VaultContext";

vi.mock("../data/db", () => ({ createDb: vi.fn(() => ({ execute: vi.fn() })) }));
vi.mock("../data/r2", () => ({ createR2Client: vi.fn(() => ({ fetch: vi.fn() })) }));
vi.mock("../data/owner", () => ({
  resolveUserId: vi.fn(),
  checkPassword: vi.fn(),
  unwrapUmk: vi.fn(),
  unwrapTxtKey: vi.fn(),
  fetchR2Config: vi.fn(),
}));
vi.mock("../data/metadata", () => ({ loadTxtMetadata: vi.fn() }));
vi.mock("../data/access", () => ({
  loadOrInitAccess: vi.fn(),
  setReadPosition: vi.fn(),
  removeAccessEntry: vi.fn(),
}));
vi.mock("../data/bookmarks", () => ({
  loadOrInitBookmarks: vi.fn(),
  addBookmark: vi.fn(),
  removeBookmark: vi.fn(),
}));

import * as accessData from "../data/access";
import * as bookmarksData from "../data/bookmarks";
import * as metadata from "../data/metadata";
import * as owner from "../data/owner";

/** Wires up the three post-auth loads (metadata/access/bookmarks) that
 * unlock() now performs, so a successful-unlock test doesn't need to spell
 * this out every time. */
function mockLibraryLoads() {
  vi.mocked(metadata.loadTxtMetadata).mockResolvedValue(new Map());
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
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(true);
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
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
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(false);

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.error).toMatch(/incorrect password/i);
  });

  it("serializes concurrent bookmark additions so neither overwrites the other", async () => {
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(true);
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
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

  it("lock() clears the session and returns to locked", async () => {
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(true);
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
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
});
