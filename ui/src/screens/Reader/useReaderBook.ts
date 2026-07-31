// Data hook backing the Reader screen (docs/ui.md's Screen 3): resolves the
// txt_key and part count once, then fetches/caches one part's raw path and
// text at a time as the reader navigates (never every part's path up front --
// see data/owner.ts's partRawPath), persisting read position and bookmarks
// along the way.
//
// Read position and bookmarks themselves are no longer fetched here -- both
// already live in VaultContext (loaded once, in full, during unlock), so
// this hook only reads/writes through the context's accessMap/bookmarksMap
// and its recordReadPosition/addBookmarkEntry/removeBookmarkEntry actions.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import type { Bookmark } from "../../data/bookmarks";
import type { BookInfo } from "../../data/metadata";
import { partCount as fetchPartCount, partRawPath } from "../../data/owner";
import { fetchPart } from "../../data/parts";
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
    getTxtKey,
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

  const txtKeyRef = useRef<Uint8Array | null>(null);
  const rawPathCache = useRef(new Map<number, string>());
  const partTextCache = useRef(new Map<number, string>());

  const bookmarks = bookmarksMap.get(txtId) ?? [];
  // Metadata for every book is already loaded in full during unlock (see
  // VaultContext) -- available instantly, unlike part count/paths/content,
  // which are only ever fetched for whichever book is actually open.
  const info: BookInfo | null = session?.metadataById.get(txtId) ?? null;

  // Load the book's key and part count once per (session, txtId) -- part
  // paths are resolved lazily, one at a time, by the part-fetch effect below
  // (see data/owner.ts's partRawPath); metadata itself needs no fetch here at
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
    rawPathCache.current = new Map();

    (async () => {
      const txtKey = await getTxtKey(txtId);
      const count = fetchPartCount(session.db, txtId);
      if (cancelled) return;

      txtKeyRef.current = txtKey;
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
  }, [session, txtId, getTxtKey]);

  // Fetch (and cache) the current part's raw path, then its text; persist
  // the read position. The raw path itself is resolved lazily here (one
  // row-read, cached in rawPathCache) rather than upfront for every part in
  // the book -- see data/owner.ts's partRawPath.
  useEffect(() => {
    if (!session || loading) return;
    const txtKey = txtKeyRef.current;
    if (!txtKey) return;

    void recordReadPosition(txtId, { lastPartNum: currentPartNum, lastAccessedMs: Date.now() });

    const cachedText = partTextCache.current.get(currentPartNum);
    if (cachedText !== undefined) {
      setPartText(cachedText);
      return;
    }

    let cancelled = false;
    setPartTextLoading(true);
    (async () => {
      let rawPath = rawPathCache.current.get(currentPartNum);
      if (rawPath === undefined) {
        const fetched = partRawPath(session.db, txtId, currentPartNum);
        if (!fetched)
          throw new Error(`no txt_parts row for txt_id=${txtId}, part_num=${currentPartNum}`);
        rawPath = fetched;
        rawPathCache.current.set(currentPartNum, rawPath);
      }
      return fetchPart(session.r2Client, session.creds.r2Config, txtKey, rawPath);
    })()
      .then((text) => {
        if (cancelled) return;
        partTextCache.current.set(currentPartNum, text);
        setPartText(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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

  const next = useCallback(() => goToPart(currentPartNum + 1), [goToPart, currentPartNum]);
  const previous = useCallback(() => goToPart(currentPartNum - 1), [goToPart, currentPartNum]);

  // Toggles: the gutter button that adds a bookmark is the same one that
  // removes it, so this looks for an existing entry at this exact
  // (part, line) before deciding which action to take.
  const bookmarkLine = useCallback(
    (line: number, txtPreview: string) => {
      const existing = bookmarks.find((b) => b.partNum === currentPartNum && b.line === line);
      if (existing) {
        void removeBookmarkEntry(existing.id);
      } else {
        void addBookmarkEntry(txtId, currentPartNum, line, txtPreview);
      }
    },
    [bookmarks, currentPartNum, addBookmarkEntry, removeBookmarkEntry, txtId],
  );

  const removeBookmark = useCallback(
    (bookmarkId: number) => {
      void removeBookmarkEntry(bookmarkId);
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
