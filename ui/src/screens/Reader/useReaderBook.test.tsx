// @vitest-environment jsdom
import type { AwsClient } from "aws4fetch";
import type { Client } from "@libsql/core/api";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { AccessMap } from "../../data/access";
import type { BookmarksMap } from "../../data/bookmarks";
import type { BookInfo } from "../../data/metadata";
import * as ownerModule from "../../data/owner";
import * as partsModule from "../../data/parts";
import * as VaultContextModule from "../../state/VaultContext";
import { useReaderBook } from "./useReaderBook";

vi.mock("../../data/owner");
vi.mock("../../data/parts");
vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<typeof import("../../state/VaultContext")>("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});

const recordReadPosition = vi.fn().mockResolvedValue(undefined);
const addBookmarkEntry = vi.fn().mockResolvedValue(undefined);
const removeBookmarkEntry = vi.fn().mockResolvedValue(undefined);

function mockVault(
  accessMap: AccessMap = new Map(),
  bookmarksMap: BookmarksMap = new Map(),
  metadataById: Map<number, BookInfo> = new Map(),
) {
  const session = {
    creds: {} as never,
    db: {} as Client,
    userId: 42,
    umk: new Uint8Array(64),
    r2Config: {} as never,
    r2Client: {} as AwsClient,
    metadataById,
    txtAccessKey: new Uint8Array(64),
    bookmarkKey: new Uint8Array(64),
  };
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session,
    error: null,
    accessMap,
    bookmarksMap,
    unlock: vi.fn(),
    lock: vi.fn(),
    getTxtKey: vi.fn().mockResolvedValue(new Uint8Array(64).fill(9)),
    recordReadPosition,
    removeAccessEntry: vi.fn(),
    addBookmarkEntry,
    removeBookmarkEntry,
  });
  return session;
}

function renderReaderBook(txtId: number, initialPath = "/") {
  return renderHook(() => useReaderBook(txtId), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>,
  });
}

describe("useReaderBook", () => {
  it("loads book data, starts at the saved read position, and fetches that part's text", async () => {
    const session = mockVault(
      new Map([[7, { lastPartNum: 14, lastAccessedMs: 1 }]]),
      new Map(),
      new Map([[7, { txtId: 7, name: "n", title: "The White Order", subjects: [], rawMetadata: [] }]]),
    );
    vi.mocked(ownerModule.partCount).mockResolvedValue(41);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(Array.from({ length: 41 }, (_, i) => `path-${i + 1}`));
    vi.mocked(partsModule.fetchPart).mockResolvedValue("Part fourteen's text.");

    const { result } = renderReaderBook(7);

    // info comes straight from session.metadataById -- available immediately,
    // not gated behind `loading` (unlike part count/paths/content).
    expect(result.current.info?.title).toBe("The White Order");

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(14);

    await waitFor(() => expect(result.current.partText).toBe("Part fourteen's text."));
    expect(partsModule.fetchPart).toHaveBeenCalledWith(
      session.r2Client,
      session.r2Config,
      expect.any(Uint8Array),
      "path-14",
    );
    expect(recordReadPosition).toHaveBeenCalledWith(7, expect.objectContaining({ lastPartNum: 14 }));
  });

  it("defaults to part 1 when there's no saved read position", async () => {
    mockVault();
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("part one");

    const { result } = renderReaderBook(3);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(1);
  });

  it("prefers a ?part= query param over the saved read position", async () => {
    mockVault(new Map([[3, { lastPartNum: 1, lastAccessedMs: 1 }]]));
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderReaderBook(3, "/?part=4");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(4);
  });

  it("prefers a ?part=&line= query param over the saved read position, and sets targetLine", async () => {
    mockVault(new Map([[3, { lastPartNum: 1, lastAccessedMs: 1 }]]));
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderReaderBook(3, "/?part=4&line=7");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(4);
    expect(result.current.targetLine).toBe(7);
  });

  it("goToBookmark() moves to the given part and sets targetLine", async () => {
    mockVault();
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderReaderBook(9);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.goToBookmark(3, 5));

    await waitFor(() => expect(result.current.currentPartNum).toBe(3));
    expect(result.current.targetLine).toBe(5);

    act(() => result.current.clearTargetLine());
    expect(result.current.targetLine).toBeNull();
  });

  it("clears partText immediately when switching parts, before the new text arrives", async () => {
    mockVault();
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    let resolveFetch: (text: string) => void = () => {};
    vi.mocked(partsModule.fetchPart).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { result } = renderReaderBook(9);
    await waitFor(() => expect(result.current.loading).toBe(false));
    resolveFetch("text for p1");
    await waitFor(() => expect(result.current.partText).toBe("text for p1"));

    act(() => result.current.goToBookmark(3, 5));
    // Immediately after requesting a jump, the *old* part's text must not
    // still be sitting around -- see useReaderBook's comment on why this
    // matters (a stale-content race that used to swallow the scroll target).
    expect(result.current.partText).toBeNull();
  });

  it("next()/previous() move within [1, partCount] and re-fetch the new part", async () => {
    mockVault(new Map([[9, { lastPartNum: 1, lastAccessedMs: 1 }]]));
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderReaderBook(9);
    await waitFor(() => expect(result.current.partText).toBe("text for p1"));

    act(() => result.current.next());
    await waitFor(() => expect(result.current.currentPartNum).toBe(2));
    await waitFor(() => expect(result.current.partText).toBe("text for p2"));

    act(() => result.current.previous());
    act(() => result.current.previous());
    await waitFor(() => expect(result.current.currentPartNum).toBe(1));
  });

  it("bookmarkLine() calls addBookmarkEntry for the current part/line/preview", async () => {
    mockVault();
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.bookmarkLine(2, "some preview text"));

    expect(addBookmarkEntry).toHaveBeenCalledWith(5, 1, 2, "some preview text");
  });

  it("exposes the current book's bookmarks straight from bookmarksMap", async () => {
    const bookmarksMap: BookmarksMap = new Map([
      [5, [{ partNum: 1, line: 2, txtPreview: "some preview text", createdAt: 1000 }]],
    ]);
    mockVault(new Map(), bookmarksMap);
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.bookmarks).toEqual([
      { partNum: 1, line: 2, txtPreview: "some preview text", createdAt: 1000 },
    ]);
  });

  it("removeBookmark() calls removeBookmarkEntry with the given createdAt", async () => {
    mockVault();
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.removeBookmark(1000));

    expect(removeBookmarkEntry).toHaveBeenCalledWith(5, 1000);
  });
});
