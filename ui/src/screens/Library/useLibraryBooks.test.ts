// @vitest-environment jsdom
import type { Client } from "@libsql/core/api";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import type { BookInfo } from "../../data/metadata";
import { withSetup } from "../../testUtils/withSetup";
import * as vaultModule from "../../state/vault";
import { useLibraryBooks } from "./useLibraryBooks";

vi.mock("../../state/vault", async () => {
  const actual = await vi.importActual<typeof import("../../state/vault")>("../../state/vault");
  return { ...actual, useVault: vi.fn() };
});

function mockVault(session: vaultModule.VaultSession | null, accessMap = new Map()) {
  vi.mocked(vaultModule.useVault).mockReturnValue({
    status: ref(session ? "unlocked" : "locked"),
    session: ref(session),
    error: ref(null),
    accessMap: ref(accessMap),
    bookmarksMap: ref(new Map()),
    unlock: vi.fn(),
    lock: vi.fn(),
    getTxtKey: vi.fn(),
    recordReadPosition: vi.fn(),
    removeAccessEntry: vi.fn(),
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry: vi.fn(),
  } as unknown as ReturnType<typeof vaultModule.useVault>);
}

const metadataById = new Map<number, BookInfo>([
  [1, { txtId: 1, name: "n1", title: "Title 1", subjects: [], rawMetadata: [] }],
  [2, { txtId: 2, name: "n2", title: "Title 2", subjects: [], rawMetadata: [] }],
]);

const session: vaultModule.VaultSession = {
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

    const { result } = withSetup(() => useLibraryBooks());

    expect(result.loading.value).toBe(false);
    expect(result.books.value).toEqual([
      { txtId: 1, info: metadataById.get(1), lastPartNum: 14, lastAccessedMs: 1000 },
      { txtId: 2, info: metadataById.get(2), lastPartNum: null, lastAccessedMs: null },
    ]);
  });

  it("is loading with a null book list before a session exists", () => {
    mockVault(null);

    const { result } = withSetup(() => useLibraryBooks());

    expect(result.loading.value).toBe(true);
    expect(result.books.value).toBeNull();
  });
});
