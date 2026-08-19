import {
  GridList,
  GridListItem,
  Link,
  ListLayout,
  Virtualizer,
  type Selection,
} from "react-aria-components";
import { IconButton } from "../../components/IconButton";
import type { LibraryBook } from "../../data/libraryDb";
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
    <div className="d-flex flex-column flex-grow-1 overflow-hidden min-w-0">
      <Virtualizer layout={ListLayout} layoutOptions={{ rowSize: ROW_HEIGHT_PX }}>
        <GridList
          aria-label="Books"
          items={books}
          selectionMode="single"
          selectionBehavior="replace"
          selectedKeys={selectedTxtId === null ? [] : [selectedTxtId]}
          onSelectionChange={(selection) => onSelectBook(selectedId(selection))}
          className="flex-grow-1 overflow-y-auto overflow-x-hidden px-2 px-md-3 book-list-grid min-w-0"
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
    <div className="flex-grow-1 overflow-y-auto overflow-x-hidden px-3 min-w-0">
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
  onRemove,
  removeLabel,
}: {
  rowId?: string | number;
  book: LibraryBook;
  initialCfi?: string | null;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <GridListItem
      id={rowId ?? `${book.txtId}-${initialCfi ?? "book"}`}
      textValue={book.title}
      focusMode="child"
      className="position-relative book-row-container"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <BookLinkRow book={book} initialCfi={initialCfi} hasRemoveAction />
      <IconButton
        label={removeLabel}
        icon="trash"
        className="border-0 position-absolute top-50 end-0 translate-middle-y me-1 compact-delete-button book-row-remove"
        onPress={onRemove}
      />
    </GridListItem>
  );
}

function BookLinkRow({
  book,
  initialCfi,
  hasRemoveAction = false,
}: {
  book: LibraryBook;
  initialCfi?: string | null;
  hasRemoveAction?: boolean;
}) {
  const active = book.lastAccessed > 0 || book.bookmarkCount > 0;
  return (
    <Link
      href={readerPath(book.txtId, initialCfi)}
      className={classNames(
        "d-block py-2 px-2 rounded-3 text-decoration-none text-body book-row h-100",
        hasRemoveAction && "pe-5",
      )}
    >
      <BookRowDetails book={book} active={active} />
    </Link>
  );
}

function BookRowContent({ book }: { book: LibraryBook }) {
  const active = book.lastAccessed > 0 || book.bookmarkCount > 0;
  return (
    <div className="d-block py-2 px-2 rounded-3 text-body book-row h-100">
      <BookRowDetails book={book} active={active} />
    </div>
  );
}

function BookRowDetails({ book, active }: { book: LibraryBook; active: boolean }) {
  return (
    <span className="d-block overflow-hidden min-w-0">
      <span className="d-flex align-items-center gap-2">
        <span
          className={classNames(
            "book-row-icon flex-shrink-0 d-flex align-items-center justify-content-center rounded-circle",
            active && "book-row-icon-active",
          )}
        >
          <i className="bi bi-journal-bookmark" aria-hidden="true" />
        </span>
        <span className="text-truncate fw-medium min-w-0 flex-grow-1">
          {book.title}
        </span>
      </span>
      <BookMetadata book={book} />
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

function BookMetadata({ book }: { book: LibraryBook }) {
  return (
    <span className="d-flex align-items-center gap-1 min-w-0 overflow-hidden book-row-meta mt-1">
      {book.bookmarkCount > 0 && <BookmarkBadge count={book.bookmarkCount} />}
      {book.lastAccessed > 0 && <LastAccessedBadge timestamp={book.lastAccessed} />}
      {book.authors.length > 0 && (
        <span className="text-truncate small text-muted min-w-0">
          {book.authors.join(", ")}
        </span>
      )}
    </span>
  );
}

function LastAccessedBadge({ timestamp }: { timestamp: number }) {
  const formatted = formatLastAccessed(timestamp);
  return (
    <span
      className="badge rounded-pill text-bg-light border fw-normal flex-shrink-0"
      aria-label={`Last accessed ${formatted}`}
    >
      <i className="bi bi-clock-history me-1" aria-hidden="true" />
      {formatted}
    </span>
  );
}

function BookmarkBadge({ count }: { count: number }) {
  return (
    <span
      className="badge rounded-pill text-bg-light border fw-normal flex-shrink-0"
      aria-label={`${count} bookmark${count === 1 ? "" : "s"}`}
    >
      <i className="bi bi-bookmark-fill me-1" aria-hidden="true" />
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
    <div className="text-center text-muted py-5">
      <i className="bi bi-journal-x fs-1 d-block mb-2" aria-hidden="true" />
      {message}
    </div>
  );
}
