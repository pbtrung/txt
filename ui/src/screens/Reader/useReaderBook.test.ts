// @vitest-environment jsdom
import type { AwsClient } from "aws4fetch";
import type { Client } from "@libsql/core/api";
import { waitFor } from "@testing-library/vue";
import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import type { AccessMap } from "../../data/access";
import type { BookmarksMap } from "../../data/bookmarks";
import type { BookInfo } from "../../data/metadata";
import * as ownerModule from "../../data/owner";
import * as partsModule from "../../data/parts";
import * as vaultModule from "../../state/vault";
import { withSetup } from "../../testUtils/withSetup";
import { useReaderBook } from "./useReaderBook";

vi.mock("../../data/owner");
vi.mock("../../data/parts");
vi.mock("../../state/vault", () => ({ useVault: vi.fn() }));
vi.mock("vue-router", () => ({ useRoute: vi.fn() }));

import { useRoute } from "vue-router";

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
  vi.mocked(vaultModule.useVault).mockReturnValue({
    status: ref("unlocked"),
    session: ref(session),
    error: ref(null),
    accessMap: ref(accessMap),
    bookmarksMap: ref(bookmarksMap),
    unlock: vi.fn(),
    lock: vi.fn(),
    getTxtKey: vi.fn().mockResolvedValue(new Uint8Array(64).fill(9)),
    recordReadPosition,
    removeAccessEntry: vi.fn(),
    addBookmarkEntry,
    removeBookmarkEntry,
  } as unknown as ReturnType<typeof vaultModule.useVault>);
  return session;
}

function mockRoute(query: Record<string, string> = {}) {
  vi.mocked(useRoute).mockReturnValue({ query } as unknown as ReturnType<typeof useRoute>);
}

function renderReaderBook(txtId: number, query: Record<string, string> = {}) {
  mockRoute(query);
  return withSetup(() => useReaderBook(computed(() => txtId)));
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
    expect(result.info.value?.title).toBe("The White Order");

    await waitFor(() => expect(result.loading.value).toBe(false));
    expect(result.currentPartNum.value).toBe(14);

    await waitFor(() => expect(result.partText.value).toBe("Part fourteen's text."));
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
    await waitFor(() => expect(result.loading.value).toBe(false));
    expect(result.currentPartNum.value).toBe(1);
  });

  it("prefers a ?part= query param over the saved read position", async () => {
    mockVault(new Map([[3, { lastPartNum: 1, lastAccessedMs: 1 }]]));
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderReaderBook(3, { part: "4" });
    await waitFor(() => expect(result.loading.value).toBe(false));
    expect(result.currentPartNum.value).toBe(4);
  });

  it("prefers a ?part=&line= query param over the saved read position, and sets targetLine", async () => {
    mockVault(new Map([[3, { lastPartNum: 1, lastAccessedMs: 1 }]]));
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderReaderBook(3, { part: "4", line: "7" });
    await waitFor(() => expect(result.loading.value).toBe(false));
    expect(result.currentPartNum.value).toBe(4);
    expect(result.targetLine.value).toBe(7);
  });

  it("goToBookmark() moves to the given part and sets targetLine", async () => {
    mockVault();
    vi.mocked(ownerModule.partCount).mockResolvedValue(5);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3", "p4", "p5"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderReaderBook(9);
    await waitFor(() => expect(result.loading.value).toBe(false));

    result.goToBookmark(3, 5);

    await waitFor(() => expect(result.currentPartNum.value).toBe(3));
    expect(result.targetLine.value).toBe(5);

    result.clearTargetLine();
    expect(result.targetLine.value).toBeNull();
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
    await waitFor(() => expect(result.loading.value).toBe(false));
    resolveFetch("text for p1");
    await waitFor(() => expect(result.partText.value).toBe("text for p1"));

    result.goToBookmark(3, 5);
    // Immediately after requesting a jump, the *old* part's text must not
    // still be sitting around -- see useReaderBook's comment on why this
    // matters (a stale-content race that used to swallow the scroll target).
    expect(result.partText.value).toBeNull();
  });

  it("next()/previous() move within [1, partCount] and re-fetch the new part", async () => {
    mockVault(new Map([[9, { lastPartNum: 1, lastAccessedMs: 1 }]]));
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockImplementation(async (_c, _cfg, _key, path) => `text for ${path}`);

    const { result } = renderReaderBook(9);
    await waitFor(() => expect(result.partText.value).toBe("text for p1"));

    result.next();
    await waitFor(() => expect(result.currentPartNum.value).toBe(2));
    await waitFor(() => expect(result.partText.value).toBe("text for p2"));

    result.previous();
    result.previous();
    await waitFor(() => expect(result.currentPartNum.value).toBe(1));
  });

  it("bookmarkLine() calls addBookmarkEntry for the current part/line/preview", async () => {
    mockVault();
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.loading.value).toBe(false));

    result.bookmarkLine(2, "some preview text");

    expect(addBookmarkEntry).toHaveBeenCalledWith(5, 1, 2, "some preview text");
  });

  it("bookmarkLine() removes the existing bookmark instead of adding a duplicate when the line is already bookmarked", async () => {
    const bookmarksMap: BookmarksMap = new Map([
      [5, [{ partNum: 1, line: 2, txtPreview: "some preview text", createdAt: 1000 }]],
    ]);
    mockVault(new Map(), bookmarksMap);
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.loading.value).toBe(false));

    const addCallsBefore = addBookmarkEntry.mock.calls.length;
    result.bookmarkLine(2, "some preview text");

    expect(removeBookmarkEntry).toHaveBeenCalledWith(5, 1000);
    expect(addBookmarkEntry.mock.calls.length).toBe(addCallsBefore); // took the remove path, not add
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
    await waitFor(() => expect(result.loading.value).toBe(false));

    expect(result.bookmarks.value).toEqual([{ partNum: 1, line: 2, txtPreview: "some preview text", createdAt: 1000 }]);
  });

  it("removeBookmark() calls removeBookmarkEntry with the given createdAt", async () => {
    mockVault();
    vi.mocked(ownerModule.partCount).mockResolvedValue(3);
    vi.mocked(ownerModule.partRawPaths).mockResolvedValue(["p1", "p2", "p3"]);
    vi.mocked(partsModule.fetchPart).mockResolvedValue("text");

    const { result } = renderReaderBook(5);
    await waitFor(() => expect(result.loading.value).toBe(false));

    result.removeBookmark(1000);

    expect(removeBookmarkEntry).toHaveBeenCalledWith(5, 1000);
  });
});
