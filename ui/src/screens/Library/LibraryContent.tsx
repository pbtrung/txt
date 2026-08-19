import { IconButton } from "../../components/IconButton";
import { useMemo } from "react";
import { Button, GridList } from "react-aria-components";
import type { LibraryBook } from "../../data/libraryDb";
import type { BookShare } from "../../data/shares";
import { BookList, BookRow, EmptyState } from "./BookList";
import {
  browseEntries,
  createBookSearch,
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
  selectedTxtId,
  onSelectBook,
  onNavigate,
  onClearAccess,
  onClearBookmarks,
  shares,
  onCopyShare,
  onDeleteShare,
}: {
  books: LibraryBook[];
  view: LibraryView;
  query: string;
  selectedTxtId: number | null;
  onSelectBook: (txtId: number | null) => void;
  onNavigate: (view: LibraryView) => void;
  onClearAccess: (txtId: number) => void;
  onClearBookmarks: (txtId: number) => void;
  shares: BookShare[];
  onCopyShare: (share: BookShare) => void;
  onDeleteShare: (share: BookShare) => void;
}) {
  const search = useMemo(() => createBookSearch(books), [books]);
  const filteredBooks = useMemo(
    () => (view.kind === "books" ? visibleBooks(search, query, view.filter) : []),
    [query, search, view],
  );
  return (
    <div className="d-flex flex-column flex-grow-1 overflow-hidden">
      <ContentHeader view={view} onNavigate={onNavigate} />
      {view.kind === "recent" ? (
        <RecentBooks {...{ books, onClearAccess, onClearBookmarks }} />
      ) : view.kind === "shares" ? (
        <SharesList {...{ shares, onCopyShare, onDeleteShare }} />
      ) : view.kind === "entries" ? (
        <EntriesList {...{ books, query, onNavigate }} dimension={view.dimension} />
      ) : (
        <BookList
          books={filteredBooks}
          totalCount={books.length}
          selectedTxtId={selectedTxtId}
          onSelectBook={onSelectBook}
        />
      )}
    </div>
  );
}

function SharesList({
  shares,
  onCopyShare,
  onDeleteShare,
}: {
  shares: BookShare[];
  onCopyShare: (share: BookShare) => void;
  onDeleteShare: (share: BookShare) => void;
}) {
  if (!shares.length) return <EmptyStateContainer message="No shared books yet." />;
  return (
    <GridList
      aria-label="Shares"
      className="book-row-grid overflow-y-auto px-2 px-md-3"
    >
      {shares.map((share) => (
        <BookRow
          key={share.id}
          book={{
            txtId: share.txtId,
            title: share.title,
            authors: [],
            subjects: [],
            publisher: null,
            lastAccessed: 0,
            bookmarkCount: 0,
            lastBookmarked: null,
            latestBookmarkCfi: null,
          }}
          removeLabel={`Delete share for ${share.title}`}
          onRemove={() => onDeleteShare(share)}
          action={
            <Button
              className="btn btn-sm btn-outline-secondary"
              isDisabled={share.state !== "active"}
              onPress={() => onCopyShare(share)}
            >
              <i className="bi bi-copy me-1" aria-hidden="true" />
              Copy
            </Button>
          }
        />
      ))}
    </GridList>
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
          onPress={() => onNavigate({ kind: "entries", dimension: filter.dimension })}
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
        openAtLatestBookmark
        removeLabel={(book) => `Delete bookmarks for ${book.title}`}
        onRemove={onClearBookmarks}
      />
    </div>
  );
}

function RecentSection({
  title,
  books,
  openAtLatestBookmark = false,
  removeLabel,
  onRemove,
}: {
  title: string;
  books: LibraryBook[];
  openAtLatestBookmark?: boolean;
  removeLabel: (book: LibraryBook) => string;
  onRemove: (txtId: number) => void;
}) {
  if (!books.length) return null;
  return (
    <section className="mb-3" aria-label={title}>
      <h3 className="h6 text-muted px-2 py-2 mb-0">{title}</h3>
      <GridList aria-label={title} className="book-row-grid">
        {books.map((book) => (
          <BookRow
            key={book.txtId}
            book={book}
            initialCfi={openAtLatestBookmark ? book.latestBookmarkCfi : null}
            removeLabel={removeLabel(book)}
            onRemove={() => onRemove(book.txtId)}
          />
        ))}
      </GridList>
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
    <Button
      className="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
      onPress={() => onNavigate({ kind: "books", filter: { dimension, value } })}
    >
      <span className="text-truncate min-w-0">{value}</span>
      <span className="badge rounded-pill text-bg-dark flex-shrink-0">{count}</span>
    </Button>
  );
}
