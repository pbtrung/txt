// Pure data-shaping logic for the Library screen (docs/ui.md's Screen 2):
// combining each txt's metadata, part count, and read position into one
// LibraryBook, then deriving the Recent/All books/Authors/Subjects/
// Publishers views from that list. Kept free of React so it's easily unit
// tested and so useLibraryBooks.ts (the data-fetching hook) stays thin.

import type { Client } from "@libsql/core/api";

import { getReadPosition } from "../../data/access";
import { loadTxtMetadata, type BookInfo } from "../../data/metadata";
import { listTxtIds, partCount as fetchPartCount } from "../../data/owner";

export interface LibraryBook {
  txtId: number;
  info: BookInfo;
  partCount: number;
  lastPartNum: number | null;
  lastAccessedMs: number | null;
}

export type BookStatus = "not-started" | "in-progress" | "finished";

export function bookStatus(book: LibraryBook): BookStatus {
  if (book.lastPartNum === null) return "not-started";
  if (book.partCount > 0 && book.lastPartNum >= book.partCount) return "finished";
  return "in-progress";
}

/** 0-100. Meaningless (0) for a book with no parts yet. */
export function bookProgressPercent(book: LibraryBook): number {
  if (book.partCount === 0 || book.lastPartNum === null) return 0;
  return Math.round((Math.min(book.lastPartNum, book.partCount) / book.partCount) * 100);
}

export async function loadLibraryBooks(
  db: Client,
  userId: number,
  umk: Uint8Array,
  getTxtKey: (txtId: number) => Promise<Uint8Array>,
): Promise<LibraryBook[]> {
  const [txtIds, metadataById] = await Promise.all([listTxtIds(db, userId), loadTxtMetadata(db, userId, umk)]);

  return Promise.all(
    txtIds.map(async (txtId): Promise<LibraryBook> => {
      const txtKey = await getTxtKey(txtId);
      const [parts, readPosition] = await Promise.all([
        fetchPartCount(db, txtId),
        getReadPosition(db, txtId, userId, txtKey),
      ]);
      const info = metadataById.get(txtId) ?? { txtId, name: `txt_${txtId}`, title: `txt_${txtId}`, subjects: [] };
      return {
        txtId,
        info,
        partCount: parts,
        lastPartNum: readPosition?.lastPartNum ?? null,
        lastAccessedMs: readPosition?.lastAccessedMs ?? null,
      };
    }),
  );
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
