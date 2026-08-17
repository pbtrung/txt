import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Link } from "react-router-dom";
import type { LibraryBook } from "../../data/libraryDb";
import { classNames } from "../../util/classNames";

const ROW_HEIGHT_PX = 64;

export function BookList({
  books,
  totalCount,
}: {
  books: LibraryBook[];
  totalCount: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual returns mutable helpers that React Compiler cannot memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: books.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });
  if (books.length === 0) return <EmptyBookList totalCount={totalCount} />;
  return (
    <div ref={parentRef} className="flex-grow-1 overflow-y-auto px-2 px-md-3">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => (
          <VirtualBookRow key={row.key} book={books[row.index]} row={row} />
        ))}
      </div>
    </div>
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

function VirtualBookRow({
  book,
  row,
}: {
  book: LibraryBook;
  row: { index: number; key: string | number | bigint; start: number };
}) {
  return (
    <div
      data-index={row.index}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${row.start}px)`,
      }}
    >
      <BookRow book={book} />
    </div>
  );
}

export function BookRow({ book }: { book: LibraryBook }) {
  const active = book.lastAccessed > 0 || book.bookmarkCount > 0;
  return (
    <Link
      to={`/read/${book.txtId}`}
      className="d-block py-2 px-2 rounded-3 text-decoration-none text-body book-row"
      style={{ height: ROW_HEIGHT_PX }}
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
        <span className="d-flex align-items-center gap-1 min-w-0 book-row-meta">
          {book.bookmarkCount > 0 && <BookmarkBadge count={book.bookmarkCount} />}
          {book.lastAccessed > 0 && (
            <span
              className="badge rounded-pill text-bg-light border fw-normal flex-shrink-0"
              aria-label={`Last accessed ${formatLastAccessed(book.lastAccessed)}`}
            >
              <i className="bi bi-clock-history me-1" aria-hidden="true" />
              {formatLastAccessed(book.lastAccessed)}
            </span>
          )}
          {book.authors.length > 0 && (
            <span className="text-truncate small text-muted min-w-0">
              {book.authors.join(", ")}
            </span>
          )}
        </span>
      </span>
    </Link>
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
