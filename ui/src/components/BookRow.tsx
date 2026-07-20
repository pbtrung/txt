// One row in the Library's book list (docs/ui.md's Screen 2): title on top,
// then `Author · Subject, Subject · Publisher` underneath; a trailing
// progress bar + part count for in-progress books, a plain part count for
// unstarted ones, "Finished" for completed ones.

import { bookProgressPercent, bookStatus, type LibraryBook } from "../screens/Library/libraryModel";
import { ProgressBar } from "./ProgressBar";

interface BookRowProps {
  book: LibraryBook;
  onClick: () => void;
}

export function BookRow({ book, onClick }: BookRowProps) {
  const status = bookStatus(book);
  const subtitle = [book.info.author, book.info.subjects.join(", "), book.info.publisher]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <button
      type="button"
      className="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3 py-3 text-start"
      onClick={onClick}
    >
      {/* minWidth:0 lets a long title/subtitle actually truncate instead of
          forcing this flex item (and its siblings, e.g. the Library's left
          nav) wider than available -- flex items default to min-width:auto,
          which ignores overflow-hidden/text-truncate on a descendant. */}
      <span className="overflow-hidden" style={{ minWidth: 0 }}>
        <span className="d-block fw-semibold text-truncate">{book.info.title}</span>
        {subtitle && <span className="d-block small text-body-secondary text-truncate">{subtitle}</span>}
      </span>
      <span className="text-end flex-shrink-0" style={{ minWidth: "8rem" }}>
        {status === "finished" && <span className="small text-body-secondary">Finished</span>}
        {status === "not-started" && book.partCount !== null && (
          <span className="small text-body-secondary">
            {book.partCount} part{book.partCount === 1 ? "" : "s"}
          </span>
        )}
        {status === "in-progress" && (
          <>
            <div className="small text-body-secondary mb-1">
              Part {book.lastPartNum}
              {book.partCount !== null && `/${book.partCount}`}
            </div>
            {book.partCount !== null && <ProgressBar percent={bookProgressPercent(book)} />}
          </>
        )}
      </span>
    </button>
  );
}
