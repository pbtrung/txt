// Search + browse over the library index -- no BB open, no read-position
// or "Recent" section (see libraryIndexDb.ts's own comment on why). Reuse
// of the historical Library screen is at the logic level (libraryModel.ts)
// and naming (useLibraryBooks.ts), not literal JSX: the presentational
// pieces (BookRow/VirtualizedListGroup) were built for a different data
// shape and library size assumptions, not carried over here.
import { useState } from "react";
import { Link } from "react-router-dom";
import type { LibraryBook } from "../../data/libraryIndexDb";
import { useVault } from "../../state/VaultContext";
import { allBooksSorted, booksForDimensionValue, browseEntries, matchesSearch, type BrowseDimension } from "./libraryModel";
import { useLibraryBooks } from "./useLibraryBooks";

interface BrowseFilter {
  dimension: BrowseDimension;
  value: string;
}

const DIMENSIONS: BrowseDimension[] = ["author", "subject", "publisher"];

function visibleBooks(books: LibraryBook[], query: string, filter: BrowseFilter | null): LibraryBook[] {
  const base = filter ? booksForDimensionValue(books, filter.dimension, filter.value) : allBooksSorted(books);
  return base.filter((book) => matchesSearch(book, query));
}

export function LibraryScreen() {
  const { session } = useVault();
  const books = useLibraryBooks(session?.libraryIndexBytes);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BrowseFilter | null>(null);

  if (books === null) return <p>Loading your library…</p>;

  return (
    <div>
      <h1>Library</h1>
      <input type="search" placeholder="Search" aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <BrowsePanel books={books} filter={filter} onFilterChange={setFilter} />
      <BookList books={visibleBooks(books, query, filter)} />
    </div>
  );
}

function BrowsePanel({
  books,
  filter,
  onFilterChange,
}: {
  books: LibraryBook[];
  filter: BrowseFilter | null;
  onFilterChange: (filter: BrowseFilter | null) => void;
}) {
  return (
    <nav aria-label="Browse">
      {DIMENSIONS.map((dimension) => (
        <BrowseGroup key={dimension} dimension={dimension} books={books} filter={filter} onFilterChange={onFilterChange} />
      ))}
    </nav>
  );
}

function BrowseGroup({
  dimension,
  books,
  filter,
  onFilterChange,
}: {
  dimension: BrowseDimension;
  books: LibraryBook[];
  filter: BrowseFilter | null;
  onFilterChange: (filter: BrowseFilter | null) => void;
}) {
  const entries = browseEntries(books, dimension);
  if (entries.length === 0) return null;
  return (
    <section>
      <h2>{dimension}</h2>
      <ul>
        {entries.map((entry) => {
          const active = filter?.dimension === dimension && filter.value === entry.value;
          return (
            <li key={entry.value}>
              <button type="button" onClick={() => onFilterChange(active ? null : { dimension, value: entry.value })}>
                {entry.value} ({entry.count})
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BookList({ books }: { books: LibraryBook[] }) {
  return (
    <ul>
      {books.map((book) => (
        <li key={book.txtId}>
          <Link to={`/read/${book.txtId}`}>{book.title}</Link>
          {book.authors.length > 0 && <span> — {book.authors.join(", ")}</span>}
        </li>
      ))}
    </ul>
  );
}
