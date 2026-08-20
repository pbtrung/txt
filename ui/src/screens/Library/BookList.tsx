import {
  GridList,
  GridListItem,
  Link,
  ListLayout,
  Virtualizer,
  type Selection,
} from "react-aria-components";
import { Bookmark, BookOpen, BookX, Clock3, FileText } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import type { LibraryBook, LibraryBookmark } from "../../data/libraryDb";
import { classNames } from "../../util/classNames";

const ROW_HEIGHT_PX = 72;

export function BookList({
  books,
  totalCount,
  selectedTxtId,
  onSelectBook,
}: {
  books: LibraryBook[];
  totalCount: number;
  selectedTxtId: number | null;
  onSelectBook: (txtId: number | null) => void;
}) {
  if (books.length === 0) return <EmptyBookList totalCount={totalCount} />;
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <Virtualizer layout={ListLayout} layoutOptions={{ rowSize: ROW_HEIGHT_PX }}>
        <GridList
          aria-label="Books"
          items={books}
          selectionMode="single"
          selectionBehavior="replace"
          selectedKeys={selectedTxtId === null ? [] : [selectedTxtId]}
          onSelectionChange={(selection) => onSelectBook(selectedId(selection))}
          className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto book-list-grid"
        >
          {/* The collection builder reads identity from this direct child's id
              before SelectableBookRow renders; keeping it here prevents filtered
              rows from being reused for a different book. */}
          {(book) => <SelectableBookRow id={book.txtId} book={book} />}
        </GridList>
      </Virtualizer>
    </div>
  );
}

function EmptyBookList({ totalCount }: { totalCount: number }) {
  const message = totalCount === 0 ? "Your library is empty." : "No books match.";
  return (
    <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3">
      <EmptyState message={message} />
    </div>
  );
}

export function SelectableBookRow({
  id,
  book,
}: {
  id: string | number;
  book: LibraryBook;
}) {
  return (
    <GridListItem
      id={id}
      textValue={book.title}
      focusMode="child"
      className="book-row-container book-select-row"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <BookRowContent book={book} />
    </GridListItem>
  );
}

export function BookRow({
  rowId,
  book,
  initialCfi,
  bookmark,
  onRemove,
  removeLabel,
}: {
  rowId?: string | number;
  book: LibraryBook;
  initialCfi?: string | null;
  bookmark?: LibraryBookmark;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <GridListItem
      id={rowId ?? `${book.txtId}-${initialCfi ?? "book"}`}
      textValue={book.title}
      focusMode="child"
      className="relative book-row-container"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <BookLinkRow
        book={book}
        initialCfi={bookmark?.cfi ?? initialCfi}
        bookmark={bookmark}
        hasRemoveAction
      />
      <IconButton
        label={removeLabel}
        icon="x-lg"
        className="btn-circle btn-ghost absolute top-1/2 right-0 mr-1 -translate-y-1/2 border-0 compact-x-button compact-delete-button book-row-remove"
        onPress={onRemove}
      />
    </GridListItem>
  );
}

function BookLinkRow({
  book,
  initialCfi,
  bookmark,
  hasRemoveAction = false,
}: {
  book: LibraryBook;
  initialCfi?: string | null;
  bookmark?: LibraryBookmark;
  hasRemoveAction?: boolean;
}) {
  const active = book.lastAccessed > 0 || book.bookmarkCount > 0;
  return (
    <Link
      href={readerPath(book.txtId, initialCfi)}
      className={classNames(
        "block h-full rounded-box px-2 py-2 text-base-content no-underline book-row",
        hasRemoveAction && "pr-12",
      )}
    >
      <BookRowDetails book={book} active={active} bookmark={bookmark} />
    </Link>
  );
}

function BookRowContent({ book }: { book: LibraryBook }) {
  const active = book.lastAccessed > 0 || book.bookmarkCount > 0;
  return (
    <div className="block h-full rounded-box px-2 py-2 text-base-content book-row">
      <BookRowDetails book={book} active={active} />
    </div>
  );
}

function BookRowDetails({
  book,
  active,
  bookmark,
}: {
  book: LibraryBook;
  active: boolean;
  bookmark?: LibraryBookmark;
}) {
  return (
    <span className="block min-w-0 overflow-hidden">
      <span className="flex items-center gap-2">
        <span
          className={classNames(
            "book-row-icon flex shrink-0 items-center justify-center rounded-full",
            active && "book-row-icon-active",
          )}
        >
          <BookOpen className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{book.title}</span>
      </span>
      <BookMetadata book={book} bookmark={bookmark} />
    </span>
  );
}

function selectedId(selection: Selection): number | null {
  if (selection === "all") return null;
  const value = selection.values().next().value;
  return typeof value === "number" ? value : null;
}

function readerPath(txtId: number, initialCfi?: string | null): string {
  const path = `/read/${txtId}`;
  if (!initialCfi) return path;
  return `${path}?${new URLSearchParams({ cfi: initialCfi })}`;
}

function BookMetadata({
  book,
  bookmark,
}: {
  book: LibraryBook;
  bookmark?: LibraryBookmark;
}) {
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden book-row-meta">
      {bookmark ? (
        <BookmarkPageBadge pageNumber={bookmark.pageNumber} />
      ) : (
        book.bookmarkCount > 0 && <BookmarkBadge count={book.bookmarkCount} />
      )}
      {bookmark ? (
        <ActivityTimeBadge label="Bookmarked" timestamp={bookmark.createdAt} />
      ) : (
        book.lastAccessed > 0 && (
          <ActivityTimeBadge label="Last accessed" timestamp={book.lastAccessed} />
        )
      )}
      {book.authors.length > 0 && (
        <span className="min-w-0 truncate text-sm text-base-content/60">
          {book.authors.join(", ")}
        </span>
      )}
    </span>
  );
}

function BookmarkPageBadge({ pageNumber }: { pageNumber: number | null }) {
  const page = pageNumber ?? "—";
  return (
    <span
      className="badge badge-sm shrink-0 gap-0 border border-base-300 bg-base-200 font-semibold"
      aria-label={pageNumber === null ? "Page unavailable" : `Page ${pageNumber}`}
    >
      <FileText className="size-3" aria-hidden="true" />
      Page {page}
    </span>
  );
}

function ActivityTimeBadge({
  label,
  timestamp,
}: {
  label: "Bookmarked" | "Last accessed";
  timestamp: number;
}) {
  const formatted = formatLastAccessed(timestamp);
  return (
    <span
      className="badge badge-sm shrink-0 gap-0 border border-base-300 bg-base-200 font-semibold"
      aria-label={`${label} ${formatted}`}
    >
      <Clock3 className="size-3" aria-hidden="true" />
      {formatted}
    </span>
  );
}

function BookmarkBadge({ count }: { count: number }) {
  return (
    <span
      className="badge badge-sm shrink-0 gap-0 border border-base-300 bg-base-200 font-semibold"
      aria-label={`${count} bookmark${count === 1 ? "" : "s"}`}
    >
      <Bookmark className="size-3" fill="currentColor" aria-hidden="true" />
      {count}
    </span>
  );
}

export function formatLastAccessed(timestamp: number): string {
  const date = new Date(timestamp);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad);
  const day = [date.getDate(), date.getMonth() + 1].map(pad);
  const year = String(date.getFullYear()).slice(-2);
  return `${time.join(":")} ${day.join("/")}/${year}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-12 text-center text-base-content/60">
      <BookX className="mx-auto mb-2 size-10" aria-hidden="true" />
      {message}
    </div>
  );
}
