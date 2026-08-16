import { IconButton } from "../../components/IconButton";
import { useMemo } from "react";
import type { LibraryBook } from "../../data/libraryDb";
import { BookList, EmptyState } from "./BookList";
import { browseEntries, type BrowseDimension } from "./libraryModel";
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
}: {
  books: LibraryBook[];
  view: LibraryView;
  query: string;
  onNavigate: (view: LibraryView) => void;
}) {
  const filteredBooks = useMemo(
    () => (view.kind === "books" ? visibleBooks(books, query, view.filter) : []),
    [books, query, view],
  );
  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      <ContentHeader view={view} onNavigate={onNavigate} />
      {view.kind === "entries" ? (
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
      <span className="badge rounded-pill text-bg-secondary flex-shrink-0">
        {count}
      </span>
    </button>
  );
}
