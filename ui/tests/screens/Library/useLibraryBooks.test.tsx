// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  LibraryBook,
  LibraryStore,
  LibraryStoreStatus,
} from "../../../src/data/libraryStore";
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
  let status: LibraryStoreStatus = { pending: false, error: null, loadedOnce: true };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => books,
    statusSnapshot: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: vi.fn(async () => {
      books = [...books, book(99, "Reloaded")];
      status = { pending: false, error: null, loadedOnce: true };
      notify();
    }),
  } as unknown as LibraryStore;
}

const NO_BOOKS: LibraryBook[] = [];

function fakeLoadingLibrary(): LibraryStore {
  // A fixed object reference, not built inline in statusSnapshot() --
  // useSyncExternalStore requires getSnapshot() to return a stable
  // reference when nothing has changed, or React re-renders forever.
  const status: LibraryStoreStatus = { pending: true, error: null, loadedOnce: false };
  return {
    snapshot: () => NO_BOOKS,
    statusSnapshot: () => status,
    subscribe: () => () => undefined,
    reload: vi.fn(),
  } as unknown as LibraryStore;
}

function fakeFailedLibrary(message: string): LibraryStore {
  const status: LibraryStoreStatus = {
    pending: false,
    error: message,
    loadedOnce: true,
  };
  return {
    snapshot: () => NO_BOOKS,
    statusSnapshot: () => status,
    subscribe: () => () => undefined,
    reload: vi.fn().mockRejectedValue(new Error(message)),
  } as unknown as LibraryStore;
}

describe("useLibraryBooks", () => {
  it("reports loading when there's no library yet", () => {
    const { result } = renderHook(() => useLibraryBooks(null));
    expect(result.current).toMatchObject({ status: "loading" });
  });

  it("reports loading before the first reload() has settled", () => {
    const { result } = renderHook(() => useLibraryBooks(fakeLoadingLibrary()));
    expect(result.current).toMatchObject({ status: "loading" });
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

  it("surfaces a failed first load", () => {
    const { result } = renderHook(() =>
      useLibraryBooks(fakeFailedLibrary("network down")),
    );
    expect(result.current).toMatchObject({ status: "error", error: "network down" });
  });
});
