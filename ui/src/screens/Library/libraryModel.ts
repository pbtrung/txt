// Pure data-shaping logic for the Library screen (docs/ui.md's Screen 2):
// combining each txt's metadata and read position into one LibraryBook,
// then deriving the Recent/All books/Authors/Subjects/Publishers views from
// that list. Kept free of React so it's easily unit tested and so
// useLibraryBooks.ts (the data-fetching hook) stays thin.

import type { Client } from "@libsql/core/api";

import { getReadPosition } from "../../data/access";
import { loadTxtMetadata, type BookInfo } from "../../data/metadata";
import { listTxtIds, partCount as fetchPartCount } from "../../data/owner";

export interface LibraryBook {
  txtId: number;
  info: BookInfo;
  /** null until loadPartCount() fills it in -- deliberately not fetched by
   * loadLibraryBooks itself, see that function's comment. */
  partCount: number | null;
  lastPartNum: number | null;
  lastAccessedMs: number | null;
}

export type BookStatus = "not-started" | "in-progress" | "finished";

export function bookStatus(book: LibraryBook): BookStatus {
  if (book.lastPartNum === null) return "not-started";
  // partCount not loaded yet: assume still in progress rather than
  // guessing "finished" -- gets corrected once loadPartCount() resolves.
  if (book.partCount === null) return "in-progress";
  if (book.partCount > 0 && book.lastPartNum >= book.partCount) return "finished";
  return "in-progress";
}

/** 0-100. Meaningless (0) for a book with no parts yet, or whose part count isn't loaded yet. */
export function bookProgressPercent(book: LibraryBook): number {
  if (book.partCount === null || book.partCount === 0 || book.lastPartNum === null) return 0;
  return Math.round((Math.min(book.lastPartNum, book.partCount) / book.partCount) * 100);
}

/** Loads every book's metadata + read position -- NOT its part count.
 *
 * part_count is deliberately left out here: fetching it for every book
 * up front doesn't scale (one more Turso round trip per book, on top of
 * the txt_key unwrap + read-position lookup each book already needs) and
 * isn't needed to render the initial list. Call loadPartCount() per book
 * afterward instead, so the list appears immediately and part counts fill
 * in progressively (see useLibraryBooks.ts).
 *
 * Each book's data is loaded independently: one failing/slow book (e.g. a
 * stale or unreachable row) is logged and skipped rather than rejecting
 * -- and so hanging the whole list -- via Promise.all.
 */
export async function loadLibraryBooks(
  db: Client,
  userId: number,
  umk: Uint8Array,
  getTxtKey: (txtId: number) => Promise<Uint8Array>,
): Promise<LibraryBook[]> {
  const [txtIds, metadataById] = await Promise.all([listTxtIds(db, userId), loadTxtMetadata(db, userId, umk)]);

  const results = await Promise.all(
    txtIds.map(async (txtId): Promise<LibraryBook | null> => {
      try {
        const txtKey = await getTxtKey(txtId);
        const readPosition = await getReadPosition(db, txtId, userId, txtKey);
        const info = metadataById.get(txtId) ?? { txtId, name: `txt_${txtId}`, title: `txt_${txtId}`, subjects: [] };
        return {
          txtId,
          info,
          partCount: null,
          lastPartNum: readPosition?.lastPartNum ?? null,
          lastAccessedMs: readPosition?.lastAccessedMs ?? null,
        };
      } catch (err) {
        console.warn(`skipping txt_id=${txtId}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }),
  );
  return results.filter((book): book is LibraryBook => book !== null);
}

/** Loads one book's part count -- see loadLibraryBooks's comment for why this is separate. */
export async function loadPartCount(db: Client, txtId: number): Promise<number> {
  return fetchPartCount(db, txtId);
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
