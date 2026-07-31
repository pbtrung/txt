// One row in the Library's book list: title on top, then
// `Author · Subject, Subject · Publisher` underneath; "Part N" for an
// in-progress book (no total/progress bar -- Library doesn't fetch
// part_count, see libraryModel.ts), unless hidePartNum is set (the Recent
// view's Continue Reading section doesn't show it). An optional onDelete
// renders a trailing "x" (also just Continue Reading).

import type { CSSProperties } from "react";
import { ClickableRow } from "./ClickableRow";
import { DeleteButton } from "./DeleteButton";
import { bookStatus, type LibraryBook } from "../screens/Library/libraryModel";

// BookRow's rendered height (py-3 padding + its two-line title/subtitle) --
// a plain constant rather than measured per-row, since every field it
// shows is text-truncate'd (never wraps), so the real height is already
// constant regardless of content. Shared by every virtualized list that
// renders BookRow (Library's Continue Reading/All books/browse-value) so
// they all agree on one source of truth.
export const BOOK_ROW_HEIGHT = 80;

interface BookRowProps {
  book: LibraryBook;
  onClick: () => void;
  onDelete?: () => void;
  hidePartNum?: boolean;
  style?: CSSProperties;
}

export function BookRow({ book, onClick, onDelete, hidePartNum, style }: BookRowProps) {
  const status = bookStatus(book);
  const subtitle = [book.info.author, book.info.subjects.join(", "), book.info.publisher]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <ClickableRow
      onClick={onClick}
      style={style}
      className="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3 py-3"
    >
      {/* minWidth:0 lets a long title/subtitle actually truncate instead of
          forcing this flex item (and its siblings, e.g. the Library's left
          nav) wider than available -- flex items default to min-width:auto,
          which ignores overflow-hidden/text-truncate on a descendant. */}
      <span className="overflow-hidden" style={{ minWidth: 0 }}>
        <span className="d-block fw-semibold text-truncate">{book.info.title}</span>
        {subtitle && (
          <span className="d-block small text-truncate text-body-secondary">{subtitle}</span>
        )}
      </span>
      <span className="d-flex align-items-center gap-2 flex-shrink-0">
        {status === "in-progress" && !hidePartNum && (
          <span className="small text-nowrap text-body-secondary">Part {book.lastPartNum}</span>
        )}
        {onDelete && (
          <DeleteButton onClick={onDelete} ariaLabel={`Remove ${book.info.title} from Recent`} />
        )}
      </span>
    </ClickableRow>
  );
}
