// A single header row split into two zones that line up with the panes
// below it: branding (icon + "Skypiea" on desktop; just the icon, doubling
// as the drawer toggle, on mobile) over the nav sidebar's own column, and
// the search box over the right pane's. Below that: a persistent nav
// sidebar (a drawer below Bootstrap's `md` breakpoint) -- All books, plus
// Authors/Subjects/Publishers each shown as a count -- and a right pane
// whose content depends on where that nav leads: the dimension's own list
// of entries (each with its own count) until one is picked, then the books
// matching it. Clicking All books shows every book directly. The book
// list is virtualized (@tanstack/react-virtual) since it renders directly
// off however many books this account has ingested, with no pagination.
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
  type BrowseEntry,
} from "./libraryModel";
import { useLibraryBooks } from "./useLibraryBooks";

interface BrowseFilter {
  dimension: BrowseDimension;
  value: string;
}

type RightView =
  | { kind: "books"; filter: BrowseFilter | null }
  | { kind: "entries"; dimension: BrowseDimension };

const DIMENSIONS: BrowseDimension[] = ["author", "subject", "publisher"];
const DIMENSION_LABEL: Record<BrowseDimension, string> = {
  author: "Authors",
  subject: "Subjects",
  publisher: "Publishers",
};
const DIMENSION_LABEL_SINGULAR: Record<BrowseDimension, string> = {
  author: "Author",
  subject: "Subject",
  publisher: "Publisher",
};
const ROW_HEIGHT_PX = 64;

function viewTitle(view: RightView): string {
  if (view.kind === "entries") return DIMENSION_LABEL[view.dimension];
  if (view.filter)
    return `${DIMENSION_LABEL_SINGULAR[view.filter.dimension]}: ${view.filter.value}`;
  return "All Books";
}

export function LibraryScreen() {
  const { session, lock } = useVault();
  const books = useLibraryBooks(session?.db ?? null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<RightView>({ kind: "books", filter: null });
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (books === null) {
    return (
      <div className="container py-5 text-center text-muted">
        <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
        Loading your library…
      </div>
    );
  }

  function goTo(next: RightView) {
    setView(next);
    setQuery("");
    setDrawerOpen(false);
  }

  return (
    <div className="d-flex flex-column vh-100 mx-auto max-w-md-80 px-2 px-md-0">
      <div className="d-flex align-items-center border-bottom flex-shrink-0">
        <div className="d-flex align-items-center gap-2 px-2 px-md-3 py-2 library-brand-col">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary d-md-none"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            <i className="bi bi-book" />
          </button>
          <div className="d-none d-md-flex align-items-center gap-2">
            <i className="bi bi-book fs-5" />
            <span className="fw-semibold fs-5">Skypiea</span>
          </div>
        </div>
        <div className="flex-grow-1 px-2 px-md-3 py-2">
          <div className="search-box position-relative">
            <i className="bi bi-search search-box-icon" aria-hidden="true" />
            <input
              type="search"
              className="form-control form-control-sm search-box-input"
              placeholder="Search…"
              aria-label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="d-flex flex-grow-1 overflow-hidden">
        <OffcanvasPanel
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="Menu"
          placement="start"
          responsive="md"
          className="h-100 border-end library-sidebar"
          style={{ width: "var(--library-sidebar-width)" }}
        >
          <SidebarContent
            books={books}
            view={view}
            displayName={session?.displayName ?? ""}
            onNavigate={goTo}
            onLock={lock}
          />
        </OffcanvasPanel>

        <RightPane books={books} view={view} query={query} onNavigate={goTo} />
      </div>
    </div>
  );
}

function SidebarContent({
  books,
  view,
  displayName,
  onNavigate,
  onLock,
}: {
  books: LibraryBook[];
  view: RightView;
  displayName: string;
  onNavigate: (view: RightView) => void;
  onLock: () => void;
}) {
  const allActive = view.kind === "books" && view.filter === null;
  return (
    <div className="d-flex flex-column h-100">
      <nav className="flex-grow-1 overflow-y-auto" aria-label="Library">
        <div className="list-group list-group-flush">
          <NavRow
            label="All Books"
            count={books.length}
            active={allActive}
            onClick={() => onNavigate({ kind: "books", filter: null })}
          />
          {DIMENSIONS.map((dimension) => {
            const active =
              (view.kind === "entries" && view.dimension === dimension) ||
              (view.kind === "books" && view.filter?.dimension === dimension);
            return (
              <NavRow
                key={dimension}
                label={DIMENSION_LABEL[dimension]}
                count={browseEntries(books, dimension).length}
                active={active}
                onClick={() => onNavigate({ kind: "entries", dimension })}
              />
            );
          })}
        </div>
      </nav>
      <div className="d-flex align-items-center justify-content-between border-top p-2 flex-shrink-0">
        <span className="d-flex align-items-center gap-2 text-truncate">
          <i className="bi bi-person-circle fs-5" aria-hidden="true" />
          <span className="text-truncate small">{displayName}</span>
        </span>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Lock"
          onClick={onLock}
        >
          <i className="bi bi-lock" />
        </button>
      </div>
    </div>
  );
}

function NavRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {label}
      <span
        className={`badge rounded-pill ${active ? "text-bg-light" : "text-bg-secondary"}`}
      >
        {count}
      </span>
    </button>
  );
}

function RightPane({
  books,
  view,
  query,
  onNavigate,
}: {
  books: LibraryBook[];
  view: RightView;
  query: string;
  onNavigate: (view: RightView) => void;
}) {
  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      <div className="d-flex align-items-center gap-2 px-2 px-md-3 pt-3 pb-2 flex-shrink-0">
        {view.kind === "books" && view.filter && (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            aria-label={`Back to ${DIMENSION_LABEL[view.filter.dimension]}`}
            onClick={() =>
              onNavigate({ kind: "entries", dimension: view.filter!.dimension })
            }
          >
            <i className="bi bi-chevron-left" />
          </button>
        )}
        <h2 className="h5 mb-0 text-truncate flex-grow-1">{viewTitle(view)}</h2>
      </div>

      {view.kind === "entries" ? (
        <EntriesList
          books={books}
          dimension={view.dimension}
          query={query}
          onSelect={onNavigate}
        />
      ) : (
        <BookList
          books={visibleBooks(books, query, view.filter)}
          totalCount={books.length}
        />
      )}
    </div>
  );
}

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

function matchesEntry(entry: BrowseEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.value.toLowerCase().includes(q);
}

function EntriesList({
  books,
  dimension,
  query,
  onSelect,
}: {
  books: LibraryBook[];
  dimension: BrowseDimension;
  query: string;
  onSelect: (view: RightView) => void;
}) {
  const entries = browseEntries(books, dimension).filter((entry) =>
    matchesEntry(entry, query),
  );

  if (entries.length === 0) {
    return (
      <div className="flex-grow-1 overflow-y-auto px-3">
        <EmptyState
          message={
            browseEntries(books, dimension).length === 0
              ? `No ${DIMENSION_LABEL[dimension].toLowerCase()} yet.`
              : "No matches."
          }
        />
      </div>
    );
  }

  return (
    <div className="flex-grow-1 overflow-y-auto px-2 px-md-3">
      <div className="list-group list-group-flush">
        {entries.map((entry) => (
          <button
            key={entry.value}
            type="button"
            className="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
            onClick={() =>
              onSelect({ kind: "books", filter: { dimension, value: entry.value } })
            }
          >
            <span className="text-truncate min-w-0">{entry.value}</span>
            <span className="badge rounded-pill text-bg-secondary flex-shrink-0">
              {entry.count}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center text-muted py-5">
      <i className="bi bi-journal-x fs-1 d-block mb-2" />
      {message}
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
      <div className="flex-grow-1 overflow-y-auto px-3">
        <EmptyState
          message={totalCount === 0 ? "Your library is empty." : "No books match."}
        />
      </div>
    );
  }

  return (
    <div ref={parentRef} className="flex-grow-1 overflow-y-auto px-2 px-md-3">
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
