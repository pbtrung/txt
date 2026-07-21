// @vitest-environment jsdom
import type { Client } from "@libsql/core/api";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import type { BookInfo } from "../../data/metadata";
import * as VaultContextModule from "../../state/VaultContext";
import { useLibraryBooks } from "./useLibraryBooks";

vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<typeof import("../../state/VaultContext")>("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});

function mockVault(session: VaultContextModule.VaultSession | null, accessMap = new Map()) {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: session ? "unlocked" : "locked",
    session,
    error: null,
    accessMap,
    bookmarksMap: new Map(),
    unlock: vi.fn(),
    lock: vi.fn(),
    getTxtKey: vi.fn(),
    recordReadPosition: vi.fn(),
    removeAccessEntry: vi.fn(),
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry: vi.fn(),
  });
}

const metadataById = new Map<number, BookInfo>([
  [1, { txtId: 1, name: "n1", title: "Title 1", subjects: [], rawMetadata: [] }],
  [2, { txtId: 2, name: "n2", title: "Title 2", subjects: [], rawMetadata: [] }],
]);

const session: VaultContextModule.VaultSession = {
  creds: {} as never,
  db: {} as Client,
  userId: 42,
  umk: new Uint8Array(64),
  r2Config: {} as never,
  r2Client: {} as never,
  metadataById,
  txtAccessKey: new Uint8Array(64),
  bookmarkKey: new Uint8Array(64),
};

describe("useLibraryBooks", () => {
  it("derives the book list from the session's metadata/access maps, no DB calls", () => {
    mockVault(session, new Map([[1, { lastPartNum: 14, lastAccessedMs: 1000 }]]));

    const { result } = renderHook(() => useLibraryBooks());

    expect(result.current.loading).toBe(false);
    expect(result.current.books).toEqual([
      { txtId: 1, info: metadataById.get(1), lastPartNum: 14, lastAccessedMs: 1000 },
      { txtId: 2, info: metadataById.get(2), lastPartNum: null, lastAccessedMs: null },
    ]);
  });

  it("is loading with a null book list before a session exists", () => {
    mockVault(null);

    const { result } = renderHook(() => useLibraryBooks());

    expect(result.current.loading).toBe(true);
    expect(result.current.books).toBeNull();
  });
});
