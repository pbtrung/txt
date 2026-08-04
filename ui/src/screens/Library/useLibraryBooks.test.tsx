// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import type { AccessMap } from "../../data/access";
import type { BookInfo } from "../../data/metadata";
import * as VaultContextModule from "../../state/VaultContext";
import { useLibraryBooks } from "./useLibraryBooks";

vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<
    typeof import("../../state/VaultContext")
  >("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});

function mockVault(
  session: VaultContextModule.VaultSession | null,
  accessMap: AccessMap = {},
) {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: session ? "unlocked" : "locked",
    session,
    error: null,
    accessMap,
    bookmarksMap: {},
    refreshing: false,
    progress: null,
    unlock: vi.fn(),
    lock: vi.fn(),
    refresh: vi.fn(),
    recordReadPosition: vi.fn(),
    removeAccessEntry: vi.fn(),
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry: vi.fn(),
  });
}

const metadataById = new Map<string, BookInfo>([
  [
    "txt-1",
    {
      txtId: "txt-1",
      name: "n1",
      title: "Title 1",
      subjects: [],
      rawMetadata: [],
    },
  ],
  [
    "txt-2",
    {
      txtId: "txt-2",
      name: "n2",
      title: "Title 2",
      subjects: [],
      rawMetadata: [],
    },
  ],
]);

const session = {
  displayName: undefined,
  instantDb: {},
  auth: {},
  authId: "auth-1",
  umk: new Uint8Array(),
  keyStorePrivKey: new Uint8Array(),
  r2Config: { endpoint: "", region: "", bucket: "" },
  metadataById,
  docKeys: new Map(),
  txtAccess: { id: null, key: new Uint8Array() },
  txtBookmarks: { id: null, key: new Uint8Array() },
} as unknown as VaultContextModule.VaultSession;

describe("useLibraryBooks", () => {
  it("derives the book list from the session's metadata/access maps, no DB calls", () => {
    mockVault(session, { "txt-1": { lastPartNum: 14, lastAccessedMs: 1000 } });

    const { result } = renderHook(() => useLibraryBooks());

    expect(result.current.loading).toBe(false);
    expect(result.current.books).toEqual([
      {
        txtId: "txt-1",
        info: metadataById.get("txt-1"),
        lastPartNum: 14,
        lastAccessedMs: 1000,
      },
      {
        txtId: "txt-2",
        info: metadataById.get("txt-2"),
        lastPartNum: null,
        lastAccessedMs: null,
      },
    ]);
  });

  it("is loading with a null book list before a session exists", () => {
    mockVault(null);

    const { result } = renderHook(() => useLibraryBooks());

    expect(result.current.loading).toBe(true);
    expect(result.current.books).toBeNull();
  });
});
