// One row in the Library's book list (docs/ui.md's Screen 2): title on top,
// then `Author · Subject, Subject · Publisher` underneath; "Part N" for an
// in-progress book (no total/progress bar -- Library doesn't fetch
// part_count, see libraryModel.ts), unless hidePartNum is set (the Recent
// view's Continue Reading section doesn't show it). An optional onDelete
// renders a trailing "x" (also just Continue Reading).

import { ClickableRow } from "./ClickableRow";
import { DeleteButton } from "./DeleteButton";
import { bookStatus, type LibraryBook } from "../screens/Library/libraryModel";

interface BookRowProps {
  book: LibraryBook;
  onClick: () => void;
  onDelete?: () => void;
  hidePartNum?: boolean;
}

export function BookRow({ book, onClick, onDelete, hidePartNum }: BookRowProps) {
  const status = bookStatus(book);
  const subtitle = [book.info.author, book.info.subjects.join(", "), book.info.publisher]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <ClickableRow
      onClick={onClick}
      className="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3 py-3"
    >
      {/* minWidth:0 lets a long title/subtitle actually truncate instead of
          forcing this flex item (and its siblings, e.g. the Library's left
          nav) wider than available -- flex items default to min-width:auto,
          which ignores overflow-hidden/text-truncate on a descendant. */}
      <span className="overflow-hidden" style={{ minWidth: 0 }}>
        <span className="d-block fw-semibold text-truncate">{book.info.title}</span>
        {subtitle && <span className="d-block small text-body-secondary text-truncate">{subtitle}</span>}
      </span>
      <span className="d-flex align-items-center gap-2 flex-shrink-0">
        {status === "in-progress" && !hidePartNum && (
          <span className="small text-body-secondary text-nowrap">Part {book.lastPartNum}</span>
        )}
        {onDelete && <DeleteButton onClick={onDelete} ariaLabel={`Remove ${book.info.title} from Recent`} />}
      </span>
    </ClickableRow>
  );
}
