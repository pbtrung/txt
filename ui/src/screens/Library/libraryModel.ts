// Pure search/sort/browse logic over an already-loaded LibraryBook[]
// (ui/src/data/libraryDb.ts).
import Fuse, { type IFuseOptions } from "fuse.js";
import type { LibraryBook } from "../../data/libraryDb";

const SEARCH_OPTIONS: IFuseOptions<LibraryBook> = {
  keys: [
    { name: "title", weight: 4 },
    { name: "authors", weight: 2 },
    { name: "subjects", weight: 1 },
    { name: "publisher", weight: 1 },
  ],
  threshold: 0.35,
  ignoreDiacritics: true,
  ignoreLocation: true,
  useTokenSearch: true,
  tokenMatch: "all",
};

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
  return searchBooks([book], query).length === 1;
}

export function searchBooks(books: LibraryBook[], query: string): LibraryBook[] {
  const search = parseSearch(query);
  const candidates = books.filter((book) => {
    if (search.activity === "access") return book.lastAccessed > 0;
    if (search.activity === "bookmark") return book.bookmarkCount > 0;
    return true;
  });
  if (!search.text) return candidates;
  return new Fuse(candidates, SEARCH_OPTIONS)
    .search(search.text)
    .map((result) => result.item);
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
