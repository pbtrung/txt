// Pure data-shaping logic for the Library screen (docs/ui.md's Screen 2):
// combining each txt's metadata and read position into one LibraryBook, and
// every txt's bookmarks into one flat, recency-sorted feed, then deriving
// the Recent/All books/Authors/Subjects/Publishers views from those. Kept
// free of React so it's easily unit tested and so useLibraryBooks.ts (the
// session-selector hook) stays thin.
//
// part_count is deliberately never fetched here: it's only needed once a
// book is open in the Reader (which already fetches it there itself) -- the
// Library list only ever shows "Part N" for an in-progress book, not a
// total or a percentage, so nothing here needs it.

import type { AccessMap } from "../../data/access";
import type { BookmarksMap } from "../../data/bookmarks";
import type { BookInfo } from "../../data/metadata";

export interface LibraryBook {
  txtId: number;
  info: BookInfo;
  lastPartNum: number | null;
  lastAccessedMs: number | null;
}

export type BookStatus = "not-started" | "in-progress";

export function bookStatus(book: LibraryBook): BookStatus {
  return book.lastPartNum === null ? "not-started" : "in-progress";
}

/** Every book this account has, combining metadata with its read position
 * (if any) -- both already loaded once, in full, during unlock (see
 * VaultContext), so this is a synchronous, in-memory combine, not a fetch. */
export function buildLibraryBooks(metadataById: Map<number, BookInfo>, accessMap: AccessMap): LibraryBook[] {
  return Array.from(metadataById.entries()).map(([txtId, info]) => {
    const position = accessMap.get(txtId);
    return {
      txtId,
      info,
      lastPartNum: position?.lastPartNum ?? null,
      lastAccessedMs: position?.lastAccessedMs ?? null,
    };
  });
}

/** Most recently opened first -- books never opened don't appear here. */
export function recentBooks(books: LibraryBook[]): LibraryBook[] {
  return books
    .filter((b) => b.lastAccessedMs !== null)
    .sort((a, b) => (b.lastAccessedMs ?? 0) - (a.lastAccessedMs ?? 0));
}

export function allBooksSorted(books: LibraryBook[]): LibraryBook[] {
  return [...books].sort((a, b) => a.info.title.localeCompare(b.info.title));
}

export function matchesSearch(book: LibraryBook, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [book.info.title, book.info.author, book.info.publisher, ...book.info.subjects]
    .filter((s): s is string => Boolean(s))
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export type BrowseDimension = "author" | "subject" | "publisher";

function dimensionValues(book: LibraryBook, dimension: BrowseDimension): string[] {
  if (dimension === "subject") return book.info.subjects;
  const value = dimension === "author" ? book.info.author : book.info.publisher;
  return value ? [value] : [];
}

export interface BrowseEntry {
  value: string;
  count: number;
}

/** Distinct values for a dimension, each with how many books carry it -- e.g. "Authors 9". */
export function browseEntries(books: LibraryBook[], dimension: BrowseDimension): BrowseEntry[] {
  const counts = new Map<string, number>();
  for (const book of books) {
    for (const value of dimensionValues(book, dimension)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

export function booksForDimensionValue(books: LibraryBook[], dimension: BrowseDimension, value: string): LibraryBook[] {
  return allBooksSorted(books.filter((book) => dimensionValues(book, dimension).includes(value)));
}

export interface RecentBookmarkItem {
  txtId: number;
  info: BookInfo;
  partNum: number;
  line: number;
  txtPreview: string;
  createdAt: number;
}

/** Every bookmark across every book, flattened and most-recently-created first. */
export function recentBookmarks(bookmarksMap: BookmarksMap, metadataById: Map<number, BookInfo>): RecentBookmarkItem[] {
  const items: RecentBookmarkItem[] = [];
  for (const [txtId, entries] of bookmarksMap) {
    const info = metadataById.get(txtId) ?? { txtId, name: `txt_${txtId}`, title: `txt_${txtId}`, subjects: [] };
    for (const entry of entries) {
      items.push({
        txtId,
        info,
        partNum: entry.partNum,
        line: entry.line,
        txtPreview: entry.txtPreview,
        createdAt: entry.createdAt,
      });
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}
