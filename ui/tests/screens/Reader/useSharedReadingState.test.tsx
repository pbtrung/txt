// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpubRenderer, ReaderLocation } from "../../../src/data/epubRenderer";
import {
  sharedLastCfi,
  useSharedReadingState,
} from "../../../src/screens/Reader/useSharedReadingState";

const SHARE_ID = "share-capability";
const STORAGE_KEY = `txt:shared-reader:v1:${SHARE_ID}`;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => vi.unstubAllGlobals());

describe("shared browser-local reading state", () => {
  it("restores and updates the last CFI without owner storage", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        lastAccessed: 1,
        lastCfi: "epubcfi(/6/2)",
        bookmarks: [],
      }),
    );
    expect(sharedLastCfi(SHARE_ID)).toBe("epubcfi(/6/2)");
    const first: ReaderLocation = {
      cfi: "epubcfi(/6/2)",
      userInitiated: false,
    };
    const { rerender } = renderHook(
      ({ location }) => useSharedReadingState(SHARE_ID, null, true, location),
      { initialProps: { location: first } },
    );
    const moved: ReaderLocation = {
      cfi: "epubcfi(/6/8)",
      userInitiated: true,
    };

    rerender({ location: moved });

    await waitFor(() => expect(sharedLastCfi(SHARE_ID)).toBe(moved.cfi));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).lastAccessed).toBeGreaterThan(
      1,
    );
  });

  it("adds and removes bookmarks in localStorage", () => {
    const renderer = {
      currentBookmark: vi.fn().mockReturnValue({
        cfi: "epubcfi(/6/4)",
        preview: "Fear is the mind-killer.",
      }),
    } as unknown as EpubRenderer;
    const location: ReaderLocation = {
      cfi: "epubcfi(/6/4)",
      userInitiated: false,
    };
    const { result } = renderHook(() =>
      useSharedReadingState(SHARE_ID, renderer, true, location),
    );

    act(() => result.current.toggleCurrent(7));

    expect(result.current.currentSaved).toBe(true);
    expect(result.current.bookmarks).toEqual([
      expect.objectContaining({
        cfi: location.cfi,
        pageNumber: 7,
        preview: "Fear is the mind-killer.",
      }),
    ]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).bookmarks).toHaveLength(1);

    act(() => result.current.remove(location.cfi));

    expect(result.current.currentSaved).toBe(false);
    expect(result.current.bookmarks).toEqual([]);
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
