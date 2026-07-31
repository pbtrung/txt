// @vitest-environment jsdom
import type { AwsClient } from "aws4fetch";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { AccessMap } from "../../data/access";
import type { BookmarksMap } from "../../data/bookmarks";
import type { BookInfo } from "../../data/metadata";
import type { R2Config } from "../../data/r2Config";
import * as partsModule from "../../data/parts";
import * as VaultContextModule from "../../state/VaultContext";
import { useReaderBook } from "./useReaderBook";

vi.mock("../../data/parts");
vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<typeof import("../../state/VaultContext")>(
    "../../state/VaultContext",
  );
  return { ...actual, useVault: vi.fn() };
});

const recordReadPosition = vi.fn().mockResolvedValue(undefined);
const addBookmarkEntry = vi.fn().mockResolvedValue(undefined);
const removeBookmarkEntry = vi.fn().mockResolvedValue(undefined);
// session.client's two SQLite-backed methods this hook calls -- the real db
// now lives inside dbWorker.ts's Worker (see that file's header comment),
// so these stand in for DbWorkerClient.partCount/partRawPath rather than a
// direct data/owner.ts call the way this test used to mock it.
const partCount = vi.fn();
const partRawPath = vi.fn();

/** useReaderBook resolves one part's raw path at a time (session.client.
 * partRawPath) rather than every part up front -- this stands in for a
 * txt_parts table indexed 1-based by `paths`' own array position. */
function mockPartRawPath(paths: string[]) {
  partRawPath.mockImplementation(
    async (_txtId: number, partNum: number) => paths[partNum - 1] ?? null,
  );
}

function mockVault(
  accessMap: AccessMap = new Map(),
  bookmarksMap: BookmarksMap = new Map(),
  metadataById: Map<number, BookInfo> = new Map(),
) {
  const session = {
    creds: { r2Config: {} as R2Config } as VaultContextModule.VaultSession["creds"],
    client: { partCount, partRawPath } as unknown as VaultContextModule.VaultSession["client"],
    r2Client: {} as AwsClient,
    metadataById,
  };
  vi.mocked(VaultContextModule.useVault).mockReturnValue({
    status: "unlocked",
    session,
    error: null,
    accessMap,
    bookmarksMap,
    refreshing: false,
    progress: null,
    unlock: vi.fn(),
    lock: vi.fn(),
    refresh: vi.fn(),
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
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
    ),
  });
}

describe("useReaderBook", () => {
  it("loads book data, starts at the saved read position, and fetches that part's text", async () => {
    const session = mockVault(
      new Map([[7, { lastPartNum: 14, lastAccessedMs: 1 }]]),
      new Map(),
      new Map([
        [7, { txtId: 7, name: "n", title: "The White Order", subjects: [], rawMetadata: [] }],
      ]),
    );
    partCount.mockResolvedValue(41);
    mockPartRawPath(Array.from({ length: 41 }, (_, i) => `path-${i + 1}`));
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
      session.creds.r2Config,
      expect.any(Uint8Array),
      "path-14",
    );
    expect(recordReadPosition).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ lastPartNum: 14 }),
    );
  });

  it("defaults to part 1 when there's no saved read position", async () => {
    mockVault();
    partCount.mockResolvedValue(5);
    mockPartRawPath(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("part one");

    const { result } = renderReaderBook(3);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(1);
  });

  it("prefers a ?part= query param over the saved read position", async () => {
    mockVault(new Map([[3, { lastPartNum: 1, lastAccessedMs: 1 }]]));
    partCount.mockResolvedValue(5);
    mockPartRawPath(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(
      async (_c, _cfg, _key, path) => `text for ${path}`,
    );

    const { result } = renderReaderBook(3, "/?part=4");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(4);
  });

  it("prefers a ?part=&line= query param over the saved read position, and sets targetLine", async () => {
    mockVault(new Map([[3, { lastPartNum: 1, lastAccessedMs: 1 }]]));
    partCount.mockResolvedValue(5);
    mockPartRawPath(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(
      async (_c, _cfg, _key, path) => `text for ${path}`,
    );

    const { result } = renderReaderBook(3, "/?part=4&line=7");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentPartNum).toBe(4);
    expect(result.current.targetLine).toBe(7);
  });

  it("goToBookmark() moves to the given part and sets targetLine", async () => {
    mockVault();
    partCount.mockResolvedValue(5);
    mockPartRawPath(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(
      async (_c, _cfg, _key, path) => `text for ${path}`,
    );

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
    partCount.mockResolvedValue(5);
    mockPartRawPath(["p1", "p2", "p3", "p4", "p5"]);
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
    partCount.mockResolvedValue(3);
    mockPartRawPath(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(
      async (_c, _cfg, _key, path) => `text for ${path}`,
    );

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
    partCount.mockResolvedValue(3);
    mockPartRawPath(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.bookmarkLine(2, "some preview text"));

    expect(addBookmarkEntry).toHaveBeenCalledWith(5, 1, 2, "some preview text");
  });

  it("bookmarkLine() removes the existing bookmark instead of adding a duplicate when the line is already bookmarked", async () => {
    const bookmarksMap: BookmarksMap = new Map([
      [
        5,
        [{ id: 88, txtId: 5, partNum: 1, line: 2, preview: "some preview text", createdAt: 1000 }],
      ],
    ]);
    mockVault(new Map(), bookmarksMap);
    partCount.mockResolvedValue(3);
    mockPartRawPath(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.current.loading).toBe(false));

    const addCallsBefore = addBookmarkEntry.mock.calls.length;
    act(() => result.current.bookmarkLine(2, "some preview text"));

    expect(removeBookmarkEntry).toHaveBeenCalledWith(88);
    expect(addBookmarkEntry.mock.calls.length).toBe(addCallsBefore); // took the remove path, not add
  });

  it("exposes the current book's bookmarks straight from bookmarksMap", async () => {
    const bookmarksMap: BookmarksMap = new Map([
      [
        5,
        [{ id: 88, txtId: 5, partNum: 1, line: 2, preview: "some preview text", createdAt: 1000 }],
      ],
    ]);
    mockVault(new Map(), bookmarksMap);
    partCount.mockResolvedValue(3);
    mockPartRawPath(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.bookmarks).toEqual([
      { id: 88, txtId: 5, partNum: 1, line: 2, preview: "some preview text", createdAt: 1000 },
    ]);
  });

  it("removeBookmark() calls removeBookmarkEntry with the given bookmark id", async () => {
    mockVault();
    partCount.mockResolvedValue(3);
    mockPartRawPath(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.removeBookmark(1000));

    expect(removeBookmarkEntry).toHaveBeenCalledWith(1000);
  });
});
