// @vitest-environment jsdom
import type { AwsClient } from "aws4fetch";
import type { Client } from "@libsql/core/api";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as accessModule from "../../data/access";
import * as bookmarksModule from "../../data/bookmarks";
import * as metadataModule from "../../data/metadata";
import * as ownerModule from "../../data/owner";
import * as partsModule from "../../data/parts";
import * as VaultContextModule from "../../state/VaultContext";
import { useReaderBook } from "./useReaderBook";

vi.mock("../../data/access");
vi.mock("../../data/bookmarks");
vi.mock("../../data/metadata");
vi.mock("../../data/owner");
vi.mock("../../data/parts");
vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<typeof import("../../state/VaultContext")>("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});

const session = {
  creds: {} as never,
  db: {} as Client,
  userId: 42,
  umk: new Uint8Array(64),
  r2Config: {} as never,
  r2Client: {} as AwsClient,
};

function mockVault(getTxtKey = vi.fn().mockResolvedValue(new Uint8Array(64).fill(9))) {
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session,
    error: null,
    unlock: vi.fn(),
    lock: vi.fn(),
    getTxtKey,
  });
}

describe("useReaderBook", () => {
  it("loads book data, starts at the saved read position, and fetches that part's text", async () => {
    mockVault();
    vi.mocked(metadataModule.getBookInfo).mockResolvedValue({
      txtId: 7,
      name: "n",
      title: "The White Order",
      subjects: [],
    });
    vi.mocked(ownerModule.partCount).mockResolvedValue(41);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(Array.from({ length: 41 }, (_, i) => `path-${i + 1}`));
    vi.mocked(accessModule.getReadPosition).mockResolvedValue({ lastPartNum: 14, lastAccessedMs: 1 });
    vi.mocked(bookmarksModule.listBookmarks).mockResolvedValue([]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("Part fourteen's text.");
    vi.mocked(accessModule.setReadPosition).mockResolvedValue(undefined);

    const { result } = renderHook(() => useReaderBook(7));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(14);
    expect(result.current.info?.title).toBe("The White Order");

    await waitFor(() => expect(result.current.partText).toBe("Part fourteen's text."));
    expect(partsModule.fetchPart).toHaveBeenCalledWith(session.r2Client, session.r2Config, expect.any(Uint8Array), "path-14");
    expect(accessModule.setReadPosition).toHaveBeenCalledWith(
      session.db,
      7,
      42,
      expect.any(Uint8Array),
      expect.objectContaining({ lastPartNum: 14 }),
    );
  });

  it("defaults to part 1 when there's no saved read position", async () => {
    mockVault();
    vi.mocked(metadataModule.getBookInfo).mockResolvedValue(null);
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(accessModule.getReadPosition).mockResolvedValue(null);
    vi.mocked(bookmarksModule.listBookmarks).mockResolvedValue([]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("part one");

    const { result } = renderHook(() => useReaderBook(3));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(1);
  });

  it("next()/previous() move within [1, partCount] and re-fetch the new part", async () => {
    mockVault();
    vi.mocked(metadataModule.getBookInfo).mockResolvedValue(null);
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(accessModule.getReadPosition).mockResolvedValue({ lastPartNum: 1, lastAccessedMs: 1 });
    vi.mocked(bookmarksModule.listBookmarks).mockResolvedValue([]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderHook(() => useReaderBook(9));
    await waitFor(() => expect(result.current.partText).toBe("text for p1"));

    act(() => result.current.next());
    await waitFor(() => expect(result.current.currentPartNum).toBe(2));
    await waitFor(() => expect(result.current.partText).toBe("text for p2"));

    act(() => result.current.previous());
    act(() => result.current.previous());
    await waitFor(() => expect(result.current.currentPartNum).toBe(1));
  });

  it("bookmarkCurrentPart() adds a bookmark and reloads the list", async () => {
    mockVault();
    vi.mocked(metadataModule.getBookInfo).mockResolvedValue(null);
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(accessModule.getReadPosition).mockResolvedValue(null);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");
    vi.mocked(bookmarksModule.listBookmarks)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 1, partNum: 1, createdAtMs: 100 }]);
    vi.mocked(bookmarksModule.addBookmark).mockResolvedValue(undefined);

    const { result } = renderHook(() => useReaderBook(5));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.bookmarkCurrentPart());

    await waitFor(() => expect(result.current.bookmarks).toEqual([{ id: 1, partNum: 1, createdAtMs: 100 }]));
    expect(bookmarksModule.addBookmark).toHaveBeenCalledWith(session.db, 5, 42, expect.any(Uint8Array), 1);
  });
});
