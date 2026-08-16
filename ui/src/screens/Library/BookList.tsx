import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Link } from "react-router-dom";
import type { LibraryBook } from "../../data/libraryDb";

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

function BookRow({ book }: { book: LibraryBook }) {
  return (
    <Link
      to={`/read/${book.txtId}`}
      className="d-flex align-items-center gap-3 py-2 px-2 rounded-3 text-decoration-none text-body book-row"
      style={{ height: ROW_HEIGHT_PX }}
    >
      <span className="book-row-icon flex-shrink-0 d-flex align-items-center justify-content-center rounded-circle">
        <i className="bi bi-journal-bookmark" aria-hidden="true" />
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

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center text-muted py-5">
      <i className="bi bi-journal-x fs-1 d-block mb-2" aria-hidden="true" />
      {message}
    </div>
  );
}
