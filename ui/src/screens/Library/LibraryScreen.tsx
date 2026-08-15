// Search + browse over the txt table's catalog: All books, plus
// browse-by-Author/Subject/Publisher. Two panes, bounded to the viewport
// height so only the panes scroll, never the page; below Bootstrap's `md`
// breakpoint the browse pane collapses into a drawer. The search box lives
// in the always-visible header (not the browse drawer) so it's reachable
// on mobile without first opening that drawer. The book list is
// virtualized (@tanstack/react-virtual) since it renders directly off
// however many books this account has ingested, with no pagination.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState } from "react";
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
const ROW_HEIGHT_PX = 64;

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

  const shown = visibleBooks(books, query, filter);

  return (
    <div className="d-flex flex-column vh-100 mx-auto max-w-md-80 px-2 px-md-0">
      <div className="border-bottom py-2 px-2 px-md-0 flex-shrink-0">
        <div className="d-flex align-items-center gap-3">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary d-md-none"
            aria-label="Browse"
            onClick={() => setBrowseOpen(true)}
          >
            <i className="bi bi-funnel" />
          </button>
          <h1 className="h4 mb-0 text-nowrap">
            <i className="bi bi-book me-2" />
            Skypiea
          </h1>
          <div className="search-box flex-grow-1 position-relative">
            <i className="bi bi-search search-box-icon" aria-hidden="true" />
            <input
              type="search"
              className="form-control form-control-sm search-box-input"
              placeholder="Search title, author, subject…"
              aria-label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {filter && (
          <div className="mt-2">
            <span className="badge rounded-pill text-bg-light border d-inline-flex align-items-center gap-2">
              {filter.dimension}: {filter.value}
              <button
                type="button"
                className="btn-close"
                style={{ fontSize: "0.6rem" }}
                aria-label="Clear filter"
                onClick={() => setFilter(null)}
              />
            </span>
          </div>
        )}
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
            <BrowsePanel
              books={books}
              filter={filter}
              onFilterChange={(next) => {
                setFilter(next);
                setBrowseOpen(false);
              }}
            />
          </div>
        </OffcanvasPanel>

        <BookList books={shown} totalCount={books.length} />
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
              <span className="text-truncate">{entry.value}</span>
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

function EmptyState({ totalCount }: { totalCount: number }) {
  return (
    <div className="text-center text-muted py-5">
      <i className="bi bi-journal-x fs-1 d-block mb-2" />
      {totalCount === 0 ? "Your library is empty." : "No books match."}
    </div>
  );
}

function BookList({ books, totalCount }: { books: LibraryBook[]; totalCount: number }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: books.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });

  if (books.length === 0) {
    return (
      <div className="flex-grow-1 overflow-y-auto p-3">
        <EmptyState totalCount={totalCount} />
      </div>
    );
  }

  return (
    <div ref={parentRef} className="flex-grow-1 overflow-y-auto px-2 px-md-3 py-2">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={books[virtualRow.index].txtId}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <BookRow book={books[virtualRow.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}

function BookRow({ book }: { book: LibraryBook }) {
  return (
    <Link
      to={`/read/${book.txtId}`}
      className="d-flex align-items-center gap-3 py-2 px-2 rounded-3 text-decoration-none text-body book-row"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <span className="book-row-icon flex-shrink-0 d-flex align-items-center justify-content-center rounded-circle">
        <i className="bi bi-journal-bookmark" />
      </span>
      <span className="overflow-hidden">
        <span className="d-block text-truncate fw-medium">{book.title}</span>
        {book.authors.length > 0 && (
          <span className="d-block text-truncate small text-muted">
            {book.authors.join(", ")}
          </span>
        )}
      </span>
    </Link>
  );
}
