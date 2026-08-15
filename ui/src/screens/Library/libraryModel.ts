// Pure search/sort/browse logic over an already-loaded LibraryBook[]
// (ui/src/data/libraryDb.ts).
import type { LibraryBook } from "../../data/libraryDb";

export function allBooksSorted(books: LibraryBook[]): LibraryBook[] {
  return [...books].sort((a, b) =>
    (a.sortKey ?? a.title).localeCompare(b.sortKey ?? b.title),
  );
}

export function matchesSearch(book: LibraryBook, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [book.title, ...book.authors, book.publisher, ...book.subjects]
    .filter((s): s is string => Boolean(s))
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export type BrowseDimension = "author" | "subject" | "publisher";

function dimensionValues(book: LibraryBook, dimension: BrowseDimension): string[] {
  if (dimension === "author") return book.authors;
  if (dimension === "subject") return book.subjects;
  return book.publisher ? [book.publisher] : [];
}

export interface BrowseEntry {
  value: string;
  count: number;
}

export function browseEntries(
  books: LibraryBook[],
  dimension: BrowseDimension,
): BrowseEntry[] {
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

export function booksForDimensionValue(
  books: LibraryBook[],
  dimension: BrowseDimension,
  value: string,
): LibraryBook[] {
  return allBooksSorted(
    books.filter((book) => dimensionValues(book, dimension).includes(value)),
  );
}
