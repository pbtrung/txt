import type { LibraryBook } from "../../data/libraryDb";
import {
  allBooksSorted,
  booksForDimensionValue,
  matchesSearch,
  type BrowseDimension,
  type BrowseEntry,
} from "./libraryModel";

interface BrowseFilter {
  dimension: BrowseDimension;
  value: string;
}

export type LibraryView =
  | { kind: "recent" }
  | { kind: "books"; filter: BrowseFilter | null }
  | { kind: "entries"; dimension: BrowseDimension };

export const DIMENSIONS: BrowseDimension[] = ["author", "subject", "publisher"];
export const DIMENSION_LABEL: Record<BrowseDimension, string> = {
  author: "Authors",
  subject: "Subjects",
  publisher: "Publishers",
};

const SINGULAR_LABEL: Record<BrowseDimension, string> = {
  author: "Author",
  subject: "Subject",
  publisher: "Publisher",
};

export function viewTitle(view: LibraryView): string {
  if (view.kind === "recent") return "Recent";
  if (view.kind === "entries") return DIMENSION_LABEL[view.dimension];
  if (!view.filter) return "All Books";
  return `${SINGULAR_LABEL[view.filter.dimension]}: ${view.filter.value}`;
}

export function visibleBooks(
  books: LibraryBook[],
  query: string,
  filter: BrowseFilter | null,
): LibraryBook[] {
  const source = filter
    ? booksForDimensionValue(books, filter.dimension, filter.value)
    : allBooksSorted(books);
  return source.filter((book) => matchesSearch(book, query));
}

export function matchesEntry(entry: BrowseEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized === "" || entry.value.toLowerCase().includes(normalized);
}
