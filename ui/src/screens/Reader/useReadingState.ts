import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EpubRenderer, ReaderLocation } from "../../data/epubRenderer";
import type { ReaderDocument } from "../../data/readerDocument";
import {
  deleteBookmarkMutation,
  listBookmarks,
  ReadingSession,
  saveBookmarkMutation,
  type BookmarkRecord,
} from "../../data/readingState";
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
  const databaseStatus = useSyncExternalStore(
    (listener) => session.database.subscribe(listener),
    () => session.database.snapshot(),
  );

  useEffect(() => {
    if (!renderer || !ready) return;
    const controller = new ReadingSession(session.database, document.txtId);
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
  }, [document.lastCfi, document.txtId, ready, renderer, session.database]);

  useEffect(() => {
    if (location)
      readingSession.current?.relocate(location.cfi, location.userInitiated);
  }, [location]);

  useEffect(() => {
    let active = true;
    void listBookmarks(session.database, document.txtId).then(
      (items) => active && setBookmarks(items),
      (error: unknown) => active && setLocalError(errorMessage(error)),
    );
    return () => {
      active = false;
    };
  }, [document.txtId, refresh, session.database]);

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
        await session.database.mutate(
          bookmarks.some((bookmark) => bookmark.cfi === current.cfi)
            ? deleteBookmarkMutation(document.txtId, current.cfi)
            : saveBookmarkMutation(
                document.txtId,
                current.cfi,
                pageNumber,
                current.preview,
              ),
        );
        setRefresh((value) => value + 1);
      } catch (error) {
        setLocalError(errorMessage(error));
      } finally {
        setBookmarkBusy(false);
      }
    },
    [bookmarkBusy, bookmarks, document.txtId, renderer, session.database],
  );

  const remove = useCallback(
    async (cfi: string) => {
      setBookmarkBusy(true);
      setLocalError(null);
      try {
        await session.database.mutate(deleteBookmarkMutation(document.txtId, cfi));
        setRefresh((value) => value + 1);
      } catch (error) {
        setLocalError(errorMessage(error));
      } finally {
        setBookmarkBusy(false);
      }
    },
    [document.txtId, session.database],
  );

  const retry = useCallback(async () => {
    setLocalError(null);
    try {
      await session.database.retry();
      setRefresh((value) => value + 1);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }, [session.database]);

  return {
    bookmarks,
    bookmarkBusy,
    currentSaved,
    toggleCurrent,
    remove,
    retry,
    databaseStatus,
    error: localError ?? databaseStatus.error,
  };
}
