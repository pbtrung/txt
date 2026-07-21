// A single bookmark row: part/line, a preview of that line's text, and a
// delete button. Shared by Library's "Recent Bookmarks" (Recent view, which
// spans every book so it shows the title too, styled as a list-group row)
// and Reader's Bookmarks dropdown (already scoped to one book, so title is
// omitted, and it isn't inside a .list-group -- className lets it supply its
// own plain row styling instead).

import { ClickableRow } from "./ClickableRow";
import { DeleteButton } from "./DeleteButton";

const DEFAULT_CLASS_NAME = "list-group-item list-group-item-action d-flex align-items-start gap-3 py-3";

interface BookmarkRowProps {
  title?: string;
  partNum: number;
  line: number;
  txtPreview: string;
  onClick: () => void;
  onDelete: () => void;
  deleteAriaLabel: string;
  className?: string;
}

export function BookmarkRow({
  title,
  partNum,
  line,
  txtPreview,
  onClick,
  onDelete,
  deleteAriaLabel,
  className = DEFAULT_CLASS_NAME,
}: BookmarkRowProps) {
  return (
    <ClickableRow onClick={onClick} className={className}>
      <i className="bi bi-bookmark-fill text-primary mt-1 flex-shrink-0" aria-hidden="true" />
      <span className="overflow-hidden flex-grow-1" style={{ minWidth: 0 }}>
        {title && <span className="d-block fw-semibold text-truncate">{title}</span>}
        <span className="d-block small text-body-secondary">
          Part {partNum} · Line {line}
        </span>
        <span className="d-block text-body-secondary fst-italic small text-truncate">&ldquo;{txtPreview}&rdquo;</span>
      </span>
      <DeleteButton onClick={onDelete} ariaLabel={deleteAriaLabel} />
    </ClickableRow>
  );
}
