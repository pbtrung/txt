// One row in Library's "Recent Bookmarks" section (Recent view): which
// book, part/line, a preview of that line's text, and a delete button.
// Clicking the row opens the reader at that spot.

import type { KeyboardEvent } from "react";

import type { RecentBookmarkItem } from "../screens/Library/libraryModel";

interface BookmarkRowProps {
  item: RecentBookmarkItem;
  onClick: () => void;
  onDelete: () => void;
}

export function BookmarkRow({ item, onClick, onDelete }: BookmarkRowProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="list-group-item list-group-item-action d-flex align-items-start gap-3 py-3"
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <i className="bi bi-bookmark-fill text-primary mt-1 flex-shrink-0" aria-hidden="true" />
      <span className="overflow-hidden flex-grow-1" style={{ minWidth: 0 }}>
        <span className="d-block fw-semibold text-truncate">{item.info.title}</span>
        <span className="d-block small text-body-secondary">
          Part {item.partNum} · Line {item.line}
        </span>
        <span className="d-block text-body-secondary fst-italic small text-truncate">
          &ldquo;{item.txtPreview}&rdquo;
        </span>
      </span>
      <button
        type="button"
        className="btn btn-xs btn-outline-secondary border-0 flex-shrink-0"
        aria-label={`Remove this bookmark in ${item.info.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <i className="bi bi-x-lg" aria-hidden="true" />
      </button>
    </div>
  );
}
