import { IconButton } from "../../components/IconButton";
import { useMemo } from "react";
import { Button, GridList, type Selection } from "react-aria-components";
import type { LibraryBook } from "../../data/libraryStore";
import type { BookShare } from "../../data/shares";
import { BookList, BookRow, EmptyState, SelectableBookRow } from "./BookList";
import {
  browseEntries,
  createBookSearch,
  recentlyAccessed,
  recentlyBookmarked,
  type BookSearchIndex,
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
  selectedShareId,
  onSelectShare,
  onNavigate,
  onClearAccess,
  onDeleteBookmark,
  shares,
  sharesError,
}: {
  books: LibraryBook[];
  view: LibraryView;
  query: string;
  selectedTxtId: number | null;
  onSelectBook: (txtId: number | null) => void;
  selectedShareId: string | null;
  onSelectShare: (shareId: string | null) => void;
  onNavigate: (view: LibraryView) => void;
  onClearAccess: (txtId: number) => void;
  onDeleteBookmark: (txtId: number, bookmarkId: number) => void;
  shares: BookShare[];
  sharesError: string | null;
}) {
  const search = useMemo(() => createBookSearch(books), [books]);
  const filteredBooks = useMemo(
    () => (view.kind === "books" ? visibleBooks(search, query, view.filter) : []),
    [query, search, view],
  );
  return (
    <div className="library-content-pane flex min-w-0 flex-1 flex-col overflow-hidden">
      <ContentHeader view={view} onNavigate={onNavigate} />
      {view.kind === "recent" ? (
        <RecentBooks {...{ books, onClearAccess }} />
      ) : view.kind === "bookmarks" ? (
        <BookmarksView {...{ books, onDeleteBookmark }} />
      ) : view.kind === "shares" ? (
        <SharesList
          {...{
            books,
            search,
            shares,
            sharesError,
            query,
            selectedShareId,
            onSelectShare,
          }}
        />
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
  books,
  search,
  shares,
  sharesError,
  query,
  selectedShareId,
  onSelectShare,
}: {
  books: LibraryBook[];
  search: BookSearchIndex;
  shares: BookShare[];
  sharesError: string | null;
  query: string;
  selectedShareId: string | null;
  onSelectShare: (shareId: string | null) => void;
}) {
  const booksById = useMemo(
    () => new Map(books.map((book) => [book.txtId, book])),
    [books],
  );
  const matchingBookIds = useMemo(() => {
    if (!query.trim()) return null;
    return new Set(search.search(query).map((book) => book.txtId));
  }, [search, query]);
  const visibleShares = matchingBookIds
    ? shares.filter((share) => matchingBookIds.has(share.txtId))
    : shares;
  if (sharesError)
    return <EmptyStateContainer message={`Could not load shares: ${sharesError}`} />;
  if (!shares.length) return <EmptyStateContainer message="No shared books yet." />;
  if (!visibleShares.length) return <EmptyStateContainer message="No shares match." />;
  return (
    <GridList
      aria-label="Shares"
      selectionMode="single"
      selectionBehavior="replace"
      selectedKeys={selectedShareId === null ? [] : [selectedShareId]}
      onSelectionChange={(selection) => onSelectShare(selectedId(selection))}
      className="book-row-grid min-w-0 overflow-x-hidden overflow-y-auto px-2 md:px-3"
    >
      {visibleShares.map((share) => (
        <SelectableBookRow
          key={share.shareIdHash}
          id={share.shareIdHash}
          book={booksById.get(share.txtId) ?? shareBookFallback(share)}
        />
      ))}
    </GridList>
  );
}

function selectedId(selection: Selection): string | null {
  if (selection === "all") return null;
  const value = selection.values().next().value;
  return typeof value === "string" ? value : null;
}

function shareBookFallback(share: BookShare): LibraryBook {
  return {
    txtId: share.txtId,
    title: share.title,
    authors: [],
    subjects: [],
    publisher: null,
    lastAccessed: 0,
    bookmarkCount: 0,
    lastBookmarked: null,
    latestBookmarkCfi: null,
    bookmarks: [],
  };
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
    <div className="flex min-w-0 shrink-0 items-center gap-2 px-2 pt-2 pb-2 md:px-3">
      {filter && (
        <IconButton
          label={`Back to ${DIMENSION_LABEL[filter.dimension]}`}
          icon="chevron-left"
          onPress={() => onNavigate({ kind: "entries", dimension: filter.dimension })}
        />
      )}
      <h2 className="mb-0 min-w-0 flex-1 truncate text-xl font-semibold">
        {viewTitle(view)}
      </h2>
    </div>
  );
}

function RecentBooks({
  books,
  onClearAccess,
}: {
  books: LibraryBook[];
  onClearAccess: (txtId: number) => void;
}) {
  const accessed = useMemo(() => recentlyAccessed(books), [books]);
  if (!accessed.length) {
    return <EmptyStateContainer message="No recent activity yet." />;
  }
  return (
    <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 md:px-3">
      <RecentSection
        title="Recent access"
        books={accessed}
        removeLabel={() => "Delete recent access"}
        onRemove={onClearAccess}
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
      <h3 className="mb-0 px-2 py-2 text-base font-semibold text-base-content/60">
        {title}
      </h3>
      <GridList aria-label={title} className="book-row-grid">
        {books.map((book) => (
          <BookRow
            key={book.txtId}
            book={book}
            removeLabel={removeLabel(book)}
            onRemove={() => onRemove(book.txtId)}
          />
        ))}
      </GridList>
    </section>
  );
}

// Its own top-level nav destination (not nested under Recent): the top 10
// most-recently-bookmarked books, one row each -- its own bookmark count
// plus its latest bookmark's page number, no last-accessed time (that
// belongs to Recent access, not here). No inner heading: ContentHeader
// already renders "Bookmarks" as this view's title.
function BookmarksView({
  books,
  onDeleteBookmark,
}: {
  books: LibraryBook[];
  onDeleteBookmark: (txtId: number, bookmarkId: number) => void;
}) {
  const bookmarked = useMemo(() => recentlyBookmarked(books), [books]);
  if (!bookmarked.length) {
    return <EmptyStateContainer message="No bookmarks yet." />;
  }
  return (
    <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 md:px-3">
      <section aria-label="Bookmarks">
        <GridList aria-label="Bookmarks" className="book-row-grid">
          {bookmarked.map((book) => (
            <BookRow
              key={book.txtId}
              book={book}
              initialCfi={book.latestBookmarkCfi}
              badges="bookmark"
              removeLabel="Delete bookmark"
              onRemove={() => {
                const latest = book.bookmarks[0];
                if (latest) onDeleteBookmark(book.txtId, latest.id);
              }}
            />
          ))}
        </GridList>
      </section>
    </div>
  );
}

function EmptyStateContainer({ message }: { message: string }) {
  return (
    <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3">
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
      <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3">
        <EmptyState message={message} />
      </div>
    );
  }
  return (
    <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 md:px-3">
      <div className="flex flex-col gap-1">
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
      className="btn btn-ghost h-auto min-h-0 w-full justify-between rounded-box px-3 py-2 font-normal"
      onPress={() => onNavigate({ kind: "books", filter: { dimension, value } })}
    >
      <span className="min-w-0 truncate">{value}</span>
      <span className="badge badge-sm shrink-0 border border-base-300 bg-base-200 font-bold">
        {count}
      </span>
    </Button>
  );
}
