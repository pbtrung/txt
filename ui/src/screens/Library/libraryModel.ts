// Pure search/sort/browse logic over an already-loaded LibraryBook[]
// (ui/src/data/libraryDb.ts).
import type { LibraryBook } from "../../data/libraryDb";

export function allBooksSorted(books: LibraryBook[]): LibraryBook[] {
  return [...books].sort((a, b) => a.title.localeCompare(b.title));
}

export function recentlyAccessed(books: LibraryBook[]): LibraryBook[] {
  return [...books]
    .filter((book) => book.lastAccessed > 0)
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .slice(0, 7);
}

export function recentlyBookmarked(books: LibraryBook[]): LibraryBook[] {
  return [...books]
    .filter((book) => book.bookmarkCount > 0)
    .sort((a, b) => (b.lastBookmarked ?? 0) - (a.lastBookmarked ?? 0))
    .slice(0, 7);
}

export function recentBookCount(books: LibraryBook[]): number {
  return books.filter((book) => book.lastAccessed > 0 || book.bookmarkCount > 0).length;
}

export function matchesSearch(book: LibraryBook, query: string): boolean {
  const search = parseSearch(query);
  if (search.activity === "access" && book.lastAccessed <= 0) return false;
  if (search.activity === "bookmark" && book.bookmarkCount <= 0) return false;
  if (!search.text) return true;
  const haystack = [book.title, ...book.authors, book.publisher, ...book.subjects]
    .filter((s): s is string => Boolean(s))
    .join(" ")
    .toLowerCase();
  return haystack.includes(search.text);
}

interface ParsedSearch {
  activity: "access" | "bookmark" | null;
  text: string;
}

export function parseSearch(query: string): ParsedSearch {
  const normalized = query.trim().toLowerCase();
  const match = /^([ab]):(?:\*|'([^']*)')$/.exec(normalized);
  if (!match) return { activity: null, text: normalized };
  return {
    activity: match[1] === "a" ? "access" : "bookmark",
    text: match[2] ?? "",
  };
}

export type BrowseDimension = "author" | "subject" | "publisher";

function dimensionValues(book: LibraryBook, dimension: BrowseDimension): string[] {
  const values =
    dimension === "author"
      ? book.authors
      : dimension === "subject"
        ? book.subjects
        : book.publisher
          ? [book.publisher]
          : [];
  return [...new Set(values.filter((value) => value.trim() !== ""))];
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
