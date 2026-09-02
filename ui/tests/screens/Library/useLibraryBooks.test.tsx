// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LibraryBook, LibraryStore } from "../../../src/data/libraryStore";
import { useLibraryBooks } from "../../../src/screens/Library/useLibraryBooks";

function book(txtId: number, title: string): LibraryBook {
  return {
    txtId,
    title,
    authors: [],
    subjects: [],
    publisher: null,
    lastAccessed: 0,
    bookmarkCount: 0,
    lastBookmarked: null,
    latestBookmarkCfi: null,
    bookmarks: [],
  };
}

function fakeLibrary(initial: LibraryBook[]): LibraryStore {
  let books = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => books,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: vi.fn(async () => {
      books = [...books, book(99, "Reloaded")];
      for (const listener of listeners) listener();
    }),
  } as unknown as LibraryStore;
}

describe("useLibraryBooks", () => {
  it("returns [] immediately when there's no library yet", () => {
    const { result } = renderHook(() => useLibraryBooks(null));
    expect(result.current).toMatchObject({ status: "ready", books: [] });
  });

  it("reads the already-loaded book list from the store's snapshot", () => {
    const library = fakeLibrary([book(1, "Dune")]);
    const { result } = renderHook(() => useLibraryBooks(library));
    expect(result.current).toMatchObject({
      status: "ready",
      books: [book(1, "Dune")],
    });
  });

  it("re-renders with the new snapshot after reload()", async () => {
    const library = fakeLibrary([book(1, "Dune")]);
    const { result } = renderHook(() => useLibraryBooks(library));

    act(() => {
      if (result.current.status === "ready") result.current.reload();
    });

    await waitFor(() =>
      expect(result.current.status === "ready" && result.current.books).toHaveLength(2),
    );
  });

  it("surfaces a reload failure", async () => {
    const noBooks: LibraryBook[] = [];
    const library = {
      snapshot: () => noBooks,
      subscribe: () => () => undefined,
      reload: vi.fn().mockRejectedValue(new Error("network down")),
    } as unknown as LibraryStore;
    const { result } = renderHook(() => useLibraryBooks(library));

    act(() => {
      if (result.current.status === "ready") result.current.reload();
    });

    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "error", error: "network down" }),
    );
  });
});
