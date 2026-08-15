// Search + browse over the txt table's catalog: All books, plus
// browse-by-Author/Subject/Publisher. Two panes, bounded to the viewport
// height so only the panes scroll, never the page; below Bootstrap's `md`
// breakpoint the browse pane collapses into a drawer.
import { useState } from "react";
import { Link } from "react-router-dom";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import type { LibraryBook } from "../../data/libraryDb";
import { useVault } from "../../state/VaultContext";
import {
  allBooksSorted,
  booksForDimensionValue,
  browseEntries,
  matchesSearch,
  type BrowseDimension,
} from "./libraryModel";
import { useLibraryBooks } from "./useLibraryBooks";

interface BrowseFilter {
  dimension: BrowseDimension;
  value: string;
}

const DIMENSIONS: BrowseDimension[] = ["author", "subject", "publisher"];

function visibleBooks(
  books: LibraryBook[],
  query: string,
  filter: BrowseFilter | null,
): LibraryBook[] {
  const base = filter
    ? booksForDimensionValue(books, filter.dimension, filter.value)
    : allBooksSorted(books);
  return base.filter((book) => matchesSearch(book, query));
}

export function LibraryScreen() {
  const { session } = useVault();
  const books = useLibraryBooks(session?.db ?? null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BrowseFilter | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  if (books === null) {
    return (
      <div className="container py-5 text-center text-muted">
        <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
        Loading your library…
      </div>
    );
  }

  return (
    <div className="d-flex flex-column vh-100 mx-auto max-w-md-80 px-3 px-md-0">
      <div className="d-flex align-items-center border-bottom py-2 flex-shrink-0">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary d-md-none me-2"
          aria-label="Browse"
          onClick={() => setBrowseOpen(true)}
        >
          <i className="bi bi-funnel" />
        </button>
        <h1 className="h3 mb-0">
          <i className="bi bi-book me-2" />
          Skypiea
        </h1>
      </div>

      <div className="d-flex flex-grow-1 overflow-hidden">
        <OffcanvasPanel
          open={browseOpen}
          onClose={() => setBrowseOpen(false)}
          title="Browse"
          placement="start"
          responsive="md"
          className="h-100 border-end"
          style={{ width: "18rem" }}
        >
          <div className="h-100 overflow-y-auto p-3 p-md-0 pe-md-3">
            <input
              type="search"
              className="form-control mb-3"
              placeholder="Search"
              aria-label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <BrowsePanel books={books} filter={filter} onFilterChange={setFilter} />
          </div>
        </OffcanvasPanel>

        <div className="flex-grow-1 overflow-y-auto p-3">
          <BookList books={visibleBooks(books, query, filter)} />
        </div>
      </div>
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
        <BrowseGroup
          key={dimension}
          dimension={dimension}
          books={books}
          filter={filter}
          onFilterChange={onFilterChange}
        />
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
    <section className="mb-3">
      <h2 className="h6 text-uppercase text-muted">{dimension}</h2>
      <div className="list-group list-group-flush">
        {entries.map((entry) => {
          const active =
            filter?.dimension === dimension && filter.value === entry.value;
          return (
            <button
              key={entry.value}
              type="button"
              className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center px-0 ${active ? "active" : ""}`}
              onClick={() =>
                onFilterChange(active ? null : { dimension, value: entry.value })
              }
            >
              {entry.value}
              <span
                className={`badge rounded-pill ${active ? "text-bg-light" : "text-bg-secondary"}`}
              >
                {entry.count}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function BookList({ books }: { books: LibraryBook[] }) {
  return (
    <ul className="list-group">
      {books.map((book) => (
        <li key={book.txtId} className="list-group-item">
          <Link to={`/read/${book.txtId}`} className="text-decoration-none">
            <i className="bi bi-file-earmark-text me-2" />
            {book.title}
          </Link>
          {book.authors.length > 0 && (
            <span className="text-muted small"> — {book.authors.join(", ")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
