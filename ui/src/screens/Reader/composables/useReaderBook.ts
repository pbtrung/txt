// Data composable backing the Reader screen (docs/ui.md's Screen 3): resolves
// the txt_key and every part's raw path once, then fetches/caches one part's
// text at a time as the reader navigates, persisting read position and
// bookmarks along the way.
//
// Read position and bookmarks themselves are no longer fetched here -- both
// already live in state/vault.ts (loaded once, in full, during unlock), so
// this composable only reads/writes through its accessMap/bookmarksMap and
// its recordReadPosition/addBookmarkEntry/removeBookmarkEntry actions.
//
// `txtId` is a ComputedRef, not a plain number: <RouterView>'s route
// component isn't remounted just because :txtId changes (navigating from one
// book's reader straight to another's re-renders the same component
// instance), so the caller must pass a reactive source for this composable's
// watchers to react to -- mirrors the original hook's [session, txtId,
// getTxtKey] effect dependency, just made explicit instead of implicit in a
// dependency array.

import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useRoute } from "vue-router";

import type { BookmarkEntry } from "../../../data/bookmarks";
import type { BookInfo } from "../../../data/metadata";
import { partCount as fetchPartCount, partRawPaths } from "../../../data/owner";
import { fetchPart } from "../../../data/parts";
import { useVault } from "../../../state/vault";
import { clampPartNum } from "../readerModel";

export interface UseReaderBookResult {
  loading: Ref<boolean>;
  error: Ref<string | null>;
  info: ComputedRef<BookInfo | null>;
  partCount: Ref<number>;
  currentPartNum: Ref<number>;
  partText: Ref<string | null>;
  partTextLoading: Ref<boolean>;
  bookmarks: ComputedRef<BookmarkEntry[]>;
  /** A line to scroll/highlight once its part's text is ready -- set by
   * goToBookmark() or an initial ?part=&line= deep link, cleared by the
   * caller (ReaderScreen) once it's been acted on. */
  targetLine: Ref<number | null>;
  clearTargetLine: () => void;
  goToPart: (partNum: number) => void;
  /** Like goToPart, but also requests a scroll/highlight to that specific line. */
  goToBookmark: (partNum: number, line: number) => void;
  next: () => void;
  previous: () => void;
  bookmarkLine: (line: number, txtPreview: string) => void;
  removeBookmark: (createdAt: number) => void;
}

export function useReaderBook(txtId: ComputedRef<number>): UseReaderBookResult {
  const { session, getTxtKey, accessMap, bookmarksMap, recordReadPosition, addBookmarkEntry, removeBookmarkEntry } =
    useVault();
  const route = useRoute();

  const loading = ref(true);
  const error = ref<string | null>(null);
  const partCount = ref(0);
  const currentPartNum = ref(1);

  const partText = ref<string | null>(null);
  const partTextLoading = ref(false);
  const targetLine = ref<number | null>(null);

  let txtKeyValue: Uint8Array | null = null;
  let rawPaths: string[] = [];
  let partTextCache = new Map<number, string>();

  const bookmarks = computed(() => bookmarksMap.value.get(txtId.value) ?? []);
  // Metadata for every book is already loaded in full during unlock (see
  // state/vault.ts) -- available instantly, unlike part count/paths/content,
  // which are only ever fetched for whichever book is actually open.
  const info = computed<BookInfo | null>(() => session.value?.metadataById.get(txtId.value) ?? null);

  // Load the book's key, part count, and part paths once per (session,
  // txtId) -- metadata itself needs no fetch here at all, see `info` above.
  // accessMap/route.query are read here only to seed the initial part --
  // deliberately not watched, since a read-position write (which updates
  // accessMap) shouldn't re-trigger a full reload.
  watch(
    [session, txtId],
    ([sessionValue, id], _prev, onCleanup) => {
      if (!sessionValue) return;
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      loading.value = true;
      error.value = null;
      // Clears out the previous book's (or part's) text immediately, rather
      // than leaving it visible until this load finishes -- otherwise
      // there's a render in between where loading/partTextLoading are both
      // false but partText is still the *old* part's, which would let a
      // pending targetLine scroll/highlight fire against stale content (see
      // ReaderScreen.vue's scroll-to-target-line watcher).
      partText.value = null;
      partTextCache = new Map();

      (async () => {
        const txtKey = await getTxtKey(id);
        const [count, paths] = await Promise.all([
          fetchPartCount(sessionValue.db, id),
          partRawPaths(sessionValue.db, id, txtKey),
        ]);
        if (cancelled) return;

        txtKeyValue = txtKey;
        rawPaths = paths;
        partCount.value = count;

        // A Library "Recent Bookmarks" click carries ?part=N&line=M -- prefer
        // that, once, over the saved read position (mirrors clicking a
        // bookmark in-screen, just from a cold load instead of an
        // already-open book).
        const requestedPart = Number(route.query.part);
        const requestedLine = Number(route.query.line);
        const initialPart =
          Number.isInteger(requestedPart) && requestedPart > 0
            ? requestedPart
            : (accessMap.value.get(id)?.lastPartNum ?? 1);
        currentPartNum.value = clampPartNum(initialPart, count);
        if (
          Number.isInteger(requestedPart) &&
          requestedPart > 0 &&
          Number.isInteger(requestedLine) &&
          requestedLine > 0
        ) {
          targetLine.value = requestedLine;
        }
        loading.value = false;
      })().catch((err: unknown) => {
        if (!cancelled) {
          error.value = err instanceof Error ? err.message : String(err);
          loading.value = false;
        }
      });
    },
    { immediate: true },
  );

  // Fetch (and cache) the current part's text; persist the read position.
  watch(
    [session, txtId, loading, currentPartNum],
    ([sessionValue, id, isLoading, partNum], _prev, onCleanup) => {
      if (!sessionValue || isLoading) return;
      const txtKey = txtKeyValue;
      const rawPath = rawPaths[partNum - 1];
      if (!txtKey || !rawPath) return;

      void recordReadPosition(id, { lastPartNum: partNum, lastAccessedMs: Date.now() });

      const cached = partTextCache.get(partNum);
      if (cached !== undefined) {
        partText.value = cached;
        return;
      }

      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      partTextLoading.value = true;
      fetchPart(sessionValue.r2Client, sessionValue.r2Config, txtKey, rawPath)
        .then((text) => {
          if (cancelled) return;
          partTextCache.set(partNum, text);
          partText.value = text;
        })
        .catch((err: unknown) => {
          if (!cancelled) error.value = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          if (!cancelled) partTextLoading.value = false;
        });
    },
    { immediate: true },
  );

  function goToPart(partNum: number): void {
    // clampPartNum always returns >= 1 for a finite partNum, but returns NaN
    // (falsy) if partNum itself is NaN -- callers other than ReaderScreen's
    // own validated part-number input (goToBookmark, a future caller) aren't
    // guaranteed to pass a validated value, so this falls back to staying put
    // rather than setting currentPartNum to NaN.
    const target = clampPartNum(partNum, partCount.value) || currentPartNum.value;
    if (target !== currentPartNum.value) {
      // Cleared in the same tick as currentPartNum, not left for the
      // part-fetch watcher to clear later -- otherwise there's a render in
      // between showing the *old* part's text under the *new* part number,
      // which is exactly the stale-content window ReaderScreen's own
      // scroll/highlight watcher has to guard against.
      partText.value = null;
    }
    currentPartNum.value = target;
  }

  function goToBookmark(partNum: number, line: number): void {
    goToPart(partNum);
    targetLine.value = line;
  }

  function clearTargetLine(): void {
    targetLine.value = null;
  }

  function next(): void {
    goToPart(currentPartNum.value + 1);
  }
  function previous(): void {
    goToPart(currentPartNum.value - 1);
  }

  // Toggles: the gutter button that adds a bookmark is the same one that
  // removes it, so this looks for an existing entry at this exact
  // (part, line) before deciding which action to take.
  function bookmarkLine(line: number, txtPreview: string): void {
    const existing = bookmarks.value.find((b) => b.partNum === currentPartNum.value && b.line === line);
    if (existing) {
      void removeBookmarkEntry(txtId.value, existing.createdAt);
    } else {
      void addBookmarkEntry(txtId.value, currentPartNum.value, line, txtPreview);
    }
  }

  function removeBookmark(createdAt: number): void {
    void removeBookmarkEntry(txtId.value, createdAt);
  }

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
