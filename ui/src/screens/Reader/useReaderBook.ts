// Data hook backing the Reader screen: resolves the part count once, then
// fetches/caches one part's content and decoded text at a time as the
// reader navigates (never every part up front), persisting read position
// and bookmarks along the way.
//
// partCount/partContent go through session.client (data/dbWorkerClient.ts)
// now, not a direct data/owner.ts call against a SqliteDb -- the db itself
// lives inside dbWorker.ts's Worker, not on the main thread (see that
// file's header comment for why). No txt_key to resolve first anymore
// either -- a part's content is a plain BLOB, protected only by SQLCipher's
// own page-level encryption (see owner.ts/parts.ts). Read position and
// bookmarks themselves are no longer fetched here at all -- both already
// live in VaultContext (loaded once, in full, during unlock), so this hook
// only reads/writes through the context's accessMap/bookmarksMap and its
// recordReadPosition/addBookmarkEntry/removeBookmarkEntry actions.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import type { Bookmark } from "../../data/bookmarks";
import type { BookInfo } from "../../data/metadata";
import { decodePart } from "../../data/parts";
import { verbose } from "../../log";
import { useVault } from "../../state/VaultContext";
import { clampPartNum } from "./readerModel";

export interface UseReaderBookResult {
  loading: boolean;
  error: string | null;
  info: BookInfo | null;
  partCount: number;
  currentPartNum: number;
  partText: string | null;
  partTextLoading: boolean;
  bookmarks: Bookmark[];
  /** A line to scroll/highlight once its part's text is ready -- set by
   * goToBookmark() or an initial ?part=&line= deep link, cleared by the
   * caller (ReaderScreen) once it's been acted on. */
  targetLine: number | null;
  clearTargetLine: () => void;
  goToPart: (partNum: number) => void;
  /** Like goToPart, but also requests a scroll/highlight to that specific line. */
  goToBookmark: (partNum: number, line: number) => void;
  next: () => void;
  previous: () => void;
  bookmarkLine: (line: number, txtPreview: string) => void;
  removeBookmark: (bookmarkId: number) => void;
}

export function useReaderBook(txtId: number): UseReaderBookResult {
  const {
    session,
    accessMap,
    bookmarksMap,
    recordReadPosition,
    addBookmarkEntry,
    removeBookmarkEntry,
  } = useVault();
  const [searchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partCount, setPartCount] = useState(0);
  const [currentPartNum, setCurrentPartNum] = useState(1);

  const [partText, setPartText] = useState<string | null>(null);
  const [partTextLoading, setPartTextLoading] = useState(false);
  const [targetLine, setTargetLine] = useState<number | null>(null);

  const partTextCache = useRef(new Map<number, string>());

  const bookmarks = bookmarksMap.get(txtId) ?? [];
  // Metadata for every book is already loaded in full during unlock (see
  // VaultContext) -- available instantly, unlike part count/content, which
  // are only ever fetched for whichever book is actually open.
  const info: BookInfo | null = session?.metadataById.get(txtId) ?? null;

  // Load the part count once per (session, txtId) -- part content is
  // resolved lazily, one at a time, by the part-fetch effect below
  // (session.client.partContent); metadata itself needs no fetch here at
  // all, see `info` above. accessMap/searchParams are read here only to seed
  // the initial part -- deliberately not in the dep list below, since a
  // read-position write (which updates accessMap) shouldn't re-trigger a
  // full reload.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Clears out the previous book's (or part's) text immediately, rather
    // than leaving it visible until this load finishes -- otherwise there's
    // a render in between where loading/partTextLoading are both false but
    // partText is still the *old* part's, which would let a pending
    // targetLine scroll/highlight fire against stale content (see below).
    setPartText(null);
    partTextCache.current = new Map();

    (async () => {
      const count = await session.client.partCount(txtId);
      if (cancelled) return;

      setPartCount(count);

      // A Library "Recent Bookmarks" click carries ?part=N&line=M -- prefer
      // that, once, over the saved read position (mirrors clicking a
      // bookmark in-screen, just from a cold load instead of an
      // already-open book).
      const requestedPart = Number(searchParams.get("part"));
      const requestedLine = Number(searchParams.get("line"));
      const initialPart =
        Number.isInteger(requestedPart) && requestedPart > 0
          ? requestedPart
          : (accessMap.get(txtId)?.lastPartNum ?? 1);
      setCurrentPartNum(clampPartNum(initialPart, count));
      if (
        Number.isInteger(requestedPart) &&
        requestedPart > 0 &&
        Number.isInteger(requestedLine) &&
        requestedLine > 0
      ) {
        setTargetLine(requestedLine);
      }
      setLoading(false);
    })().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
    // accessMap/searchParams intentionally excluded -- see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, txtId]);

  // Fetch (and cache) the current part's content, then decode it; persist
  // the read position.
  useEffect(() => {
    if (!session || loading) return;

    // Fire-and-forget on purpose (this shouldn't block showing the part
    // text), but not silently: a real failure here (e.g. instantPageStore.ts's
    // CAS retries exhausted because another session committed first) would
    // otherwise be an entirely silent unhandled rejection with zero trace of
    // what happened -- logged rather than surfaced as a blocking error, since
    // a stale read position doesn't stop reading from working.
    recordReadPosition(txtId, {
      lastPartNum: currentPartNum,
      lastAccessedMs: Date.now(),
    }).catch((err: unknown) => {
      verbose("useReaderBook: recordReadPosition failed", err);
    });

    const cachedText = partTextCache.current.get(currentPartNum);
    if (cachedText !== undefined) {
      setPartText(cachedText);
      return;
    }

    let cancelled = false;
    setPartTextLoading(true);
    (async () => {
      const content = await session.client.partContent(txtId, currentPartNum);
      if (!content)
        throw new Error(
          `no txt_parts row for txt_id=${txtId}, part_num=${currentPartNum}`,
        );
      return decodePart(content);
    })()
      .then((text) => {
        if (cancelled) return;
        partTextCache.current.set(currentPartNum, text);
        setPartText(text);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPartTextLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session, txtId, loading, currentPartNum, recordReadPosition]);

  const goToPart = useCallback(
    (partNum: number) => {
      // clampPartNum always returns >= 1 for a finite partNum, but returns
      // NaN (falsy) if partNum itself is NaN -- callers other than
      // ReaderScreen's own validated part-number input (goToBookmark, a
      // future caller) aren't guaranteed to pass a validated value, so this
      // falls back to staying put rather than setting currentPartNum to NaN.
      const target = clampPartNum(partNum, partCount) || currentPartNum;
      if (target !== currentPartNum) {
        // Cleared in the same batch as currentPartNum, not left for the
        // part-fetch effect to clear later -- otherwise there's a render in
        // between showing the *old* part's text under the *new* part
        // number, which is exactly the stale-content window the ReaderScreen
        // scroll/highlight effect has to guard against (see its comment).
        setPartText(null);
      }
      setCurrentPartNum(target);
    },
    [partCount, currentPartNum],
  );

  const goToBookmark = useCallback(
    (partNum: number, line: number) => {
      goToPart(partNum);
      setTargetLine(line);
    },
    [goToPart],
  );

  const clearTargetLine = useCallback(() => setTargetLine(null), []);

  const next = useCallback(
    () => goToPart(currentPartNum + 1),
    [goToPart, currentPartNum],
  );
  const previous = useCallback(
    () => goToPart(currentPartNum - 1),
    [goToPart, currentPartNum],
  );

  // Toggles: the gutter button that adds a bookmark is the same one that
  // removes it, so this looks for an existing entry at this exact
  // (part, line) before deciding which action to take.
  const bookmarkLine = useCallback(
    (line: number, txtPreview: string) => {
      const existing = bookmarks.find(
        (b) => b.partNum === currentPartNum && b.line === line,
      );
      if (existing) {
        removeBookmarkEntry(existing.id).catch((err: unknown) => {
          verbose("useReaderBook: removeBookmarkEntry failed", err);
        });
      } else {
        addBookmarkEntry(txtId, currentPartNum, line, txtPreview).catch(
          (err: unknown) => {
            verbose("useReaderBook: addBookmarkEntry failed", err);
          },
        );
      }
    },
    [bookmarks, currentPartNum, addBookmarkEntry, removeBookmarkEntry, txtId],
  );

  const removeBookmark = useCallback(
    (bookmarkId: number) => {
      removeBookmarkEntry(bookmarkId).catch((err: unknown) => {
        verbose("useReaderBook: removeBookmarkEntry failed", err);
      });
    },
    [removeBookmarkEntry],
  );

  return {
    loading,
    error,
    info,
    partCount,
    currentPartNum,
    partText,
    partTextLoading,
    bookmarks,
    targetLine,
    clearTargetLine,
    goToPart,
    goToBookmark,
    next,
    previous,
    bookmarkLine,
    removeBookmark,
  };
}
