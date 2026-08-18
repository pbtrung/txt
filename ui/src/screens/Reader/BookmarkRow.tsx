import { IconButton } from "../../components/IconButton";
import type { BookmarkRecord } from "../../data/readingState";

export function BookmarkRow({
  bookmark,
  bookmarkBusy,
  onNavigate,
  onRemove,
}: {
  bookmark: BookmarkRecord;
  bookmarkBusy: boolean;
  onNavigate: (cfi: string) => void;
  onRemove: (cfi: string) => void;
}) {
  return (
    <div className="d-flex align-items-center px-2 bookmark-menu-row">
      <button
        type="button"
        className="dropdown-item d-flex flex-column align-items-start min-w-0"
        onClick={() => onNavigate(bookmark.cfi)}
      >
        <span className="text-truncate w-100">
          {bookmark.preview || "Saved location"}
        </span>
        <span className="small text-muted">
          Page {bookmark.pageNumber ?? "unknown"}
        </span>
      </button>
      <IconButton
        label="Delete bookmark"
        icon="x-lg"
        className="border-0 flex-shrink-0 compact-delete-button"
        disabled={bookmarkBusy}
        onClick={() => onRemove(bookmark.cfi)}
      />
    </div>
  );
}
