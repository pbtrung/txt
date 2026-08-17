import { IconButton } from "../../components/IconButton";
import { useMemo } from "react";
import type { LibraryBook } from "../../data/libraryDb";
import { BookList, BookRow, EmptyState } from "./BookList";
import {
  browseEntries,
  recentlyAccessed,
  recentlyBookmarked,
  type BrowseDimension,
} from "./libraryModel";
import {
  DIMENSION_LABEL,
  matchesEntry,
  type LibraryView,
  viewTitle,
  visibleBooks,
} from "./libraryView";

export function LibraryContent({
  books,
  view,
  query,
  onNavigate,
  onClearAccess,
  onClearBookmarks,
}: {
  books: LibraryBook[];
  view: LibraryView;
  query: string;
  onNavigate: (view: LibraryView) => void;
  onClearAccess: (txtId: number) => void;
  onClearBookmarks: (txtId: number) => void;
}) {
  const filteredBooks = useMemo(
    () => (view.kind === "books" ? visibleBooks(books, query, view.filter) : []),
    [books, query, view],
  );
  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      <ContentHeader view={view} onNavigate={onNavigate} />
      {view.kind === "recent" ? (
        <RecentBooks {...{ books, onClearAccess, onClearBookmarks }} />
      ) : view.kind === "entries" ? (
        <EntriesList {...{ books, query, onNavigate }} dimension={view.dimension} />
      ) : (
        <BookList books={filteredBooks} totalCount={books.length} />
      )}
    </div>
  );
}

function ContentHeader({
  view,
  onNavigate,
}: {
  view: LibraryView;
  onNavigate: (view: LibraryView) => void;
}) {
  const filter = view.kind === "books" ? view.filter : null;
  return (
    <div className="d-flex align-items-center gap-2 px-2 px-md-3 pt-2 pb-2 flex-shrink-0">
      {filter && (
        <IconButton
          label={`Back to ${DIMENSION_LABEL[filter.dimension]}`}
          icon="chevron-left"
          onClick={() => onNavigate({ kind: "entries", dimension: filter.dimension })}
        />
      )}
      <h2 className="h5 mb-0 text-truncate flex-grow-1">{viewTitle(view)}</h2>
    </div>
  );
}

function RecentBooks({
  books,
  onClearAccess,
  onClearBookmarks,
}: {
  books: LibraryBook[];
  onClearAccess: (txtId: number) => void;
  onClearBookmarks: (txtId: number) => void;
}) {
  const accessed = useMemo(() => recentlyAccessed(books), [books]);
  const bookmarked = useMemo(() => recentlyBookmarked(books), [books]);
  if (!accessed.length && !bookmarked.length) {
    return <EmptyStateContainer message="No recent activity yet." />;
  }
  return (
    <div className="flex-grow-1 overflow-y-auto px-2 px-md-3">
      <RecentSection
        title="Recent access"
        books={accessed}
        removeLabel={(book) => `Clear recent access for ${book.title}`}
        onRemove={onClearAccess}
      />
      <RecentSection
        title="Bookmarks"
        books={bookmarked}
        removeLabel={(book) => `Delete bookmarks for ${book.title}`}
        onRemove={onClearBookmarks}
      />
    </div>
  );
}

function RecentSection({
  title,
  books,
  removeLabel,
  onRemove,
}: {
  title: string;
  books: LibraryBook[];
  removeLabel: (book: LibraryBook) => string;
  onRemove: (txtId: number) => void;
}) {
  if (!books.length) return null;
  return (
    <section className="mb-3" aria-label={title}>
      <h3 className="h6 text-muted px-2 py-2 mb-0">{title}</h3>
      {books.map((book) => (
        <BookRow
          key={book.txtId}
          book={book}
          removeLabel={removeLabel(book)}
          onRemove={() => onRemove(book.txtId)}
        />
      ))}
    </section>
  );
}

function EmptyStateContainer({ message }: { message: string }) {
  return (
    <div className="flex-grow-1 overflow-y-auto px-3">
      <EmptyState message={message} />
    </div>
  );
}

function EntriesList({
  books,
  dimension,
  query,
  onNavigate,
}: {
  books: LibraryBook[];
  dimension: BrowseDimension;
  query: string;
  onNavigate: (view: LibraryView) => void;
}) {
  const allEntries = useMemo(() => browseEntries(books, dimension), [books, dimension]);
  const entries = useMemo(
    () => allEntries.filter((entry) => matchesEntry(entry, query)),
    [allEntries, query],
  );
  if (entries.length === 0) {
    const message = allEntries.length
      ? "No matches."
      : `No ${DIMENSION_LABEL[dimension].toLowerCase()} yet.`;
    return (
      <div className="flex-grow-1 overflow-y-auto px-3">
        <EmptyState message={message} />
      </div>
    );
  }
  return (
    <div className="flex-grow-1 overflow-y-auto px-2 px-md-3">
      <div className="list-group list-group-flush">
        {entries.map((entry) => (
          <EntryRow
            key={entry.value}
            dimension={dimension}
            value={entry.value}
            count={entry.count}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

function EntryRow({
  dimension,
  value,
  count,
  onNavigate,
}: {
  dimension: BrowseDimension;
  value: string;
  count: number;
  onNavigate: (view: LibraryView) => void;
}) {
  return (
    <button
      type="button"
      className="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
      onClick={() => onNavigate({ kind: "books", filter: { dimension, value } })}
    >
      <span className="text-truncate min-w-0">{value}</span>
      <span className="badge rounded-pill text-bg-dark flex-shrink-0">{count}</span>
    </button>
  );
}
