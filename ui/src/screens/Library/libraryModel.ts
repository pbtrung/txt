// Pure search/sort/browse logic over an already-loaded LibraryBook[]
// (ui/src/data/libraryStore.ts).
import Fuse, { type IFuseOptions } from "fuse.js";
import type { LibraryBook } from "../../data/libraryStore";

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

const RECENT_LIST_LIMIT = 10;

export function recentlyAccessed(books: LibraryBook[]): LibraryBook[] {
  return [...books]
    .filter((book) => book.lastAccessed > 0)
    .sort((a, b) => b.lastAccessed - a.lastAccessed)
    .slice(0, RECENT_LIST_LIMIT);
}

// One row per book (never per individual bookmark, matching the server's
// own BOOKMARKS_SUMMARY_QUERY, which already collapses to each document's
// single latest bookmark) -- the worker caps this to its own top 10 by
// created_at, so the slice below is defense-in-depth, not the primary cap.
export function recentlyBookmarked(books: LibraryBook[]): LibraryBook[] {
  return [...books]
    .filter((book) => book.bookmarkCount > 0)
    .sort((a, b) => (b.lastBookmarked ?? 0) - (a.lastBookmarked ?? 0))
    .slice(0, RECENT_LIST_LIMIT);
}

export function recentAccessCount(books: LibraryBook[]): number {
  return books.filter((book) => book.lastAccessed > 0).length;
}

export function bookmarkedBookCount(books: LibraryBook[]): number {
  return books.filter((book) => book.bookmarkCount > 0).length;
}

export interface BookSearchIndex {
  search(query: string): LibraryBook[];
}

export function createBookSearch(books: LibraryBook[]): BookSearchIndex {
  const sorted = allBooksSorted(books);
  const exactRecords = sorted.map(toExactSearchRecord);
  const fuse = new Fuse(sorted, SEARCH_OPTIONS);
  return {
    search(query: string) {
      const parsed = parseSearch(query);
      const candidates = exactRecords.filter(({ book }) =>
        matchesActivity(book, parsed.activity),
      );
      if (!parsed.text) return candidates.map(({ book }) => book);
      const exact = exactMatches(candidates, normalizeSearchText(parsed.text));
      if (exact.length > 0) return exact;
      return fuse
        .search(parsed.text)
        .map((result) => result.item)
        .filter((book) => matchesActivity(book, parsed.activity));
    },
  };
}

interface ExactSearchRecord {
  book: LibraryBook;
  fields: string[];
  all: string;
}

function toExactSearchRecord(book: LibraryBook): ExactSearchRecord {
  const fields = [
    book.title,
    book.authors.join(" "),
    book.subjects.join(" "),
    book.publisher ?? "",
  ].map(normalizeSearchText);
  return { book, fields, all: fields.join(" ") };
}

function exactMatches(records: ExactSearchRecord[], query: string): LibraryBook[] {
  const ranked: LibraryBook[][] = [[], [], [], [], []];
  for (const record of records) {
    if (!record.all.includes(query)) continue;
    const field = record.fields.findIndex((value) => value.includes(query));
    ranked[field < 0 ? ranked.length - 1 : field].push(record.book);
  }
  return ranked.flat();
}

function matchesActivity(
  book: LibraryBook,
  activity: ParsedSearch["activity"],
): boolean {
  if (activity === "access") return book.lastAccessed > 0;
  if (activity === "bookmark") return book.bookmarkCount > 0;
  return true;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
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

export function bookHasDimensionValue(
  book: LibraryBook,
  dimension: BrowseDimension,
  value: string,
): boolean {
  return dimensionValues(book, dimension).includes(value);
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
    books.filter((book) => bookHasDimensionValue(book, dimension, value)),
  );
}
