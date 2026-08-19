import {
  GridList,
  GridListItem,
  Link,
  ListLayout,
  Virtualizer,
} from "react-aria-components";
import { IconButton } from "../../components/IconButton";
import type { LibraryBook } from "../../data/libraryDb";
import { classNames } from "../../util/classNames";

const ROW_HEIGHT_PX = 72;

export function BookList({
  books,
  totalCount,
}: {
  books: LibraryBook[];
  totalCount: number;
}) {
  if (books.length === 0) return <EmptyBookList totalCount={totalCount} />;
  return (
    <Virtualizer layout={ListLayout} layoutOptions={{ rowSize: ROW_HEIGHT_PX }}>
      <GridList
        aria-label="Books"
        items={books}
        className="flex-grow-1 overflow-y-auto px-2 px-md-3 book-list-grid"
      >
        {(book) => <VirtualBookRow book={book} />}
      </GridList>
    </Virtualizer>
  );
}

function EmptyBookList({ totalCount }: { totalCount: number }) {
  const message = totalCount === 0 ? "Your library is empty." : "No books match.";
  return (
    <div className="flex-grow-1 overflow-y-auto px-3">
      <EmptyState message={message} />
    </div>
  );
}

function VirtualBookRow({ book }: { book: LibraryBook }) {
  return (
    <GridListItem
      id={book.txtId}
      textValue={book.title}
      focusMode="child"
      className="book-row-container"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <BookLinkRow book={book} />
    </GridListItem>
  );
}

export function BookRow({
  book,
  initialCfi,
  onRemove,
  removeLabel,
}: {
  book: LibraryBook;
  initialCfi?: string | null;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <GridListItem
      id={`${book.txtId}-${initialCfi ?? "book"}`}
      textValue={book.title}
      focusMode="child"
      className="position-relative book-row-container"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <BookLinkRow book={book} initialCfi={initialCfi} hasRemoveAction />
      <IconButton
        label={removeLabel}
        icon="x-lg"
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
          <span className="text-truncate fw-medium">{book.title}</span>
        </span>
        <BookMetadata book={book} />
      </span>
    </Link>
  );
}

function readerPath(txtId: number, initialCfi?: string | null): string {
  const path = `/read/${txtId}`;
  if (!initialCfi) return path;
  return `${path}?${new URLSearchParams({ cfi: initialCfi })}`;
}

function BookMetadata({ book }: { book: LibraryBook }) {
  return (
    <span className="d-flex align-items-center gap-1 min-w-0 book-row-meta mt-1">
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
