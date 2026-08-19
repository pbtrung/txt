import { useCallback, useEffect, useState } from "react";
import type { EpubRenderer, ReaderLocation } from "../../data/epubRenderer";
import type { BookmarkRecord } from "../../data/readingState";
import { errorMessage } from "../../util/errorMessage";

const STORAGE_PREFIX = "txt:shared-reader:v1:";
const MAX_BOOKMARKS = 20;

interface SharedReadingRecord {
  lastAccessed: number;
  lastCfi: string | null;
  bookmarks: BookmarkRecord[];
}

const EMPTY_STATUS = { pending: false, unsaved: false, error: null } as const;

export function sharedLastCfi(shareId: string): string | null {
  return readRecord(shareId).lastCfi;
}

export function useSharedReadingState(
  shareId: string,
  renderer: EpubRenderer | null,
  ready: boolean,
  location: ReaderLocation | null,
) {
  const [bookmarks, setBookmarks] = useState(() => readRecord(shareId).bookmarks);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const saveBookmarks = useCallback(
    (next: BookmarkRecord[]) => {
      try {
        writeRecord(shareId, { ...readRecord(shareId), bookmarks: next });
        setBookmarks(next);
        setLocalError(null);
      } catch (error) {
        setLocalError(errorMessage(error));
      }
    },
    [shareId],
  );

  useEffect(() => {
    tryWriteRecord(shareId, { ...readRecord(shareId), lastAccessed: Date.now() });
  }, [shareId]);

  useEffect(() => {
    if (ready && location?.userInitiated) {
      tryWriteRecord(shareId, {
        ...readRecord(shareId),
        lastCfi: location.cfi,
      });
    }
  }, [location, ready, shareId]);

  const currentCfi = location?.cfi ?? null;
  const currentSaved =
    currentCfi !== null && bookmarks.some((bookmark) => bookmark.cfi === currentCfi);

  const toggleCurrent = useCallback(
    (pageNumber: number) => {
      if (!renderer || bookmarkBusy) return;
      const current = renderer.currentBookmark();
      if (!current) return;
      setBookmarkBusy(true);
      const existing = bookmarks.some((bookmark) => bookmark.cfi === current.cfi);
      const next = existing
        ? bookmarks.filter((bookmark) => bookmark.cfi !== current.cfi)
        : [
            {
              id: nextBookmarkId(bookmarks),
              cfi: current.cfi,
              pageNumber,
              preview: current.preview,
              createdAt: Date.now(),
            },
            ...bookmarks,
          ].slice(0, MAX_BOOKMARKS);
      saveBookmarks(next);
      setBookmarkBusy(false);
    },
    [bookmarkBusy, bookmarks, renderer, saveBookmarks],
  );

  const remove = useCallback(
    (cfi: string) => {
      saveBookmarks(bookmarks.filter((bookmark) => bookmark.cfi !== cfi));
    },
    [bookmarks, saveBookmarks],
  );

  const retry = useCallback(() => saveBookmarks(bookmarks), [bookmarks, saveBookmarks]);
  return {
    bookmarks,
    bookmarkBusy,
    currentSaved,
    toggleCurrent,
    remove,
    retry,
    databaseStatus: EMPTY_STATUS,
    error: localError,
  };
}

function readRecord(shareId: string): SharedReadingRecord {
  const fallback: SharedReadingRecord = {
    lastAccessed: 0,
    lastCfi: null,
    bookmarks: [],
  };
  try {
    const value = localStorage.getItem(storageKey(shareId));
    if (!value) return fallback;
    const parsed = JSON.parse(value) as Partial<SharedReadingRecord>;
    return {
      lastAccessed: typeof parsed.lastAccessed === "number" ? parsed.lastAccessed : 0,
      lastCfi: typeof parsed.lastCfi === "string" ? parsed.lastCfi : null,
      bookmarks: Array.isArray(parsed.bookmarks)
        ? parsed.bookmarks.filter(validBookmark).slice(0, MAX_BOOKMARKS)
        : [],
    };
  } catch {
    return fallback;
  }
}

function validBookmark(value: unknown): value is BookmarkRecord {
  if (!value || typeof value !== "object") return false;
  const bookmark = value as Partial<BookmarkRecord>;
  return (
    typeof bookmark.id === "number" &&
    typeof bookmark.cfi === "string" &&
    (bookmark.pageNumber === null || typeof bookmark.pageNumber === "number") &&
    typeof bookmark.preview === "string" &&
    typeof bookmark.createdAt === "number"
  );
}

function nextBookmarkId(bookmarks: BookmarkRecord[]): number {
  return bookmarks.reduce((maximum, bookmark) => Math.max(maximum, bookmark.id), 0) + 1;
}

function storageKey(shareId: string): string {
  return `${STORAGE_PREFIX}${shareId}`;
}

function writeRecord(shareId: string, record: SharedReadingRecord): void {
  localStorage.setItem(storageKey(shareId), JSON.stringify(record));
}

function tryWriteRecord(shareId: string, record: SharedReadingRecord): void {
  try {
    writeRecord(shareId, record);
  } catch {
    // Reading remains usable when browser-local persistence is unavailable.
  }
}
