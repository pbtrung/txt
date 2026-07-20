// Data hook backing the Reader screen (docs/ui.md's Screen 3): resolves the
// txt_key and every part's raw path once, then fetches/caches one part's
// text at a time as the reader navigates, persisting read position and
// bookmarks along the way.

import { useCallback, useEffect, useRef, useState } from "react";

import { getReadPosition, setReadPosition } from "../../data/access";
import { addBookmark, listBookmarks, type Bookmark } from "../../data/bookmarks";
import { getBookInfo, type BookInfo } from "../../data/metadata";
import { partCount as fetchPartCount, partRawPaths } from "../../data/owner";
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
  goToPart: (partNum: number) => void;
  next: () => void;
  previous: () => void;
  bookmarkCurrentPart: () => void;
}

export function useReaderBook(txtId: number): UseReaderBookResult {
  const { session, getTxtKey } = useVault();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<BookInfo | null>(null);
  const [partCount, setPartCount] = useState(0);
  const [currentPartNum, setCurrentPartNum] = useState(1);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  const [partText, setPartText] = useState<string | null>(null);
  const [partTextLoading, setPartTextLoading] = useState(false);

  const txtKeyRef = useRef<Uint8Array | null>(null);
  const rawPathsRef = useRef<string[]>([]);
  const partTextCache = useRef(new Map<number, string>());

  // Load the book's key, metadata, part count, initial read position, and
  // bookmarks once per (session, txtId).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    partTextCache.current = new Map();

    (async () => {
      const txtKey = await getTxtKey(txtId);
      const [bookInfo, count, rawPaths, readPosition, bookmarkList] = await Promise.all([
        getBookInfo(session.db, session.userId, session.umk, txtId),
        fetchPartCount(session.db, txtId),
        partRawPaths(session.db, txtId, txtKey),
        getReadPosition(session.db, txtId, session.userId, txtKey),
        listBookmarks(session.db, txtId, session.userId, txtKey),
      ]);
      if (cancelled) return;

      txtKeyRef.current = txtKey;
      rawPathsRef.current = rawPaths;
      setInfo(bookInfo);
      setPartCount(count);
      setBookmarks(bookmarkList);
      setCurrentPartNum(clampPartNum(readPosition?.lastPartNum ?? 1, count));
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
  }, [session, txtId, getTxtKey]);

  // Fetch (and cache) the current part's text; persist the read position.
  useEffect(() => {
    if (!session || loading) return;
    const txtKey = txtKeyRef.current;
    const rawPath = rawPathsRef.current[currentPartNum - 1];
    if (!txtKey || !rawPath) return;

    void setReadPosition(session.db, txtId, session.userId, txtKey, {
      lastPartNum: currentPartNum,
      lastAccessedMs: Date.now(),
    });

    const cached = partTextCache.current.get(currentPartNum);
    if (cached !== undefined) {
      setPartText(cached);
      return;
    }

    let cancelled = false;
    setPartTextLoading(true);
    fetchPart(session.r2Client, session.r2Config, txtKey, rawPath)
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
  }, [session, txtId, loading, currentPartNum]);

  const goToPart = useCallback(
    (partNum: number) => {
      setCurrentPartNum((current) => clampPartNum(partNum, partCount) || current);
    },
    [partCount],
  );

  const next = useCallback(() => goToPart(currentPartNum + 1), [goToPart, currentPartNum]);
  const previous = useCallback(() => goToPart(currentPartNum - 1), [goToPart, currentPartNum]);

  const bookmarkCurrentPart = useCallback(() => {
    if (!session) return;
    const txtKey = txtKeyRef.current;
    if (!txtKey) return;
    void addBookmark(session.db, txtId, session.userId, txtKey, currentPartNum).then(() =>
      listBookmarks(session.db, txtId, session.userId, txtKey).then(setBookmarks),
    );
  }, [session, txtId, currentPartNum]);

  return {
    loading,
    error,
    info,
    partCount,
    currentPartNum,
    partText,
    partTextLoading,
    bookmarks,
    goToPart,
    next,
    previous,
    bookmarkCurrentPart,
  };
}
