import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EpubRenderer, ReaderLocation } from "../../data/epubRenderer";
import type { BookmarkRecord } from "../../data/libraryStore";
import type { ReaderDocument } from "../../data/readerDocument";
import { ReadingSession } from "../../data/readingState";
import type { VaultSession } from "../../state/VaultContext";
import { errorMessage } from "../../util/errorMessage";

export function useReadingState(
  session: VaultSession,
  document: ReaderDocument,
  renderer: EpubRenderer | null,
  ready: boolean,
  location: ReaderLocation | null,
) {
  const readingSession = useRef<ReadingSession | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([]);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const libraryStatus = useSyncExternalStore(
    (listener) => session.library.subscribe(listener),
    () => session.library.statusSnapshot(),
  );

  useEffect(() => {
    if (!renderer || !ready) return;
    const controller = new ReadingSession(session.library, document.txtId);
    controller.onSaveError((error) => setLocalError(errorMessage(error)));
    controller.start(
      document.lastCfi,
      globalThis.document.visibilityState !== "hidden",
    );
    const onVisibilityChange = () =>
      controller.setVisible(globalThis.document.visibilityState !== "hidden");
    globalThis.document.addEventListener("visibilitychange", onVisibilityChange);
    readingSession.current = controller;
    return () => {
      globalThis.document.removeEventListener("visibilitychange", onVisibilityChange);
      controller.dispose();
      if (readingSession.current === controller) readingSession.current = null;
    };
  }, [document.lastCfi, document.txtId, ready, renderer, session.library]);

  useEffect(() => {
    if (location)
      readingSession.current?.relocate(location.cfi, location.userInitiated);
  }, [location]);

  useEffect(() => {
    let active = true;
    void session.library.listBookmarks(document.txtId).then(
      (items) => active && setBookmarks(items),
      (error: unknown) => active && setLocalError(errorMessage(error)),
    );
    return () => {
      active = false;
    };
  }, [document.txtId, refresh, session.library]);

  const currentCfi = location?.cfi ?? null;
  const currentSaved =
    currentCfi !== null && bookmarks.some((bookmark) => bookmark.cfi === currentCfi);

  const toggleCurrent = useCallback(
    async (pageNumber: number) => {
      if (!renderer || bookmarkBusy) return;
      const current = renderer.currentBookmark();
      if (!current) return;
      setBookmarkBusy(true);
      setLocalError(null);
      try {
        const existing = bookmarks.find((bookmark) => bookmark.cfi === current.cfi);
        if (existing) {
          await session.library.deleteBookmark(existing.id);
        } else {
          await session.library.saveBookmark(
            document.txtId,
            current.cfi,
            pageNumber,
            current.preview,
          );
        }
        setRefresh((value) => value + 1);
      } catch (error) {
        setLocalError(errorMessage(error));
      } finally {
        setBookmarkBusy(false);
      }
    },
    [bookmarkBusy, bookmarks, document.txtId, renderer, session.library],
  );

  const remove = useCallback(
    async (cfi: string) => {
      const existing = bookmarks.find((bookmark) => bookmark.cfi === cfi);
      if (!existing) return;
      setBookmarkBusy(true);
      setLocalError(null);
      try {
        await session.library.deleteBookmark(existing.id);
        setRefresh((value) => value + 1);
      } catch (error) {
        setLocalError(errorMessage(error));
      } finally {
        setBookmarkBusy(false);
      }
    },
    [bookmarks, session.library],
  );

  const retry = useCallback(() => {
    setLocalError(null);
    readingSession.current?.retry();
  }, []);

  return {
    bookmarks,
    bookmarkBusy,
    currentSaved,
    toggleCurrent,
    remove,
    retry,
    libraryStatus,
    error: localError ?? libraryStatus.error,
  };
}
