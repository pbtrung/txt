import { IconButton } from "../../components/IconButton";
import { Button } from "react-aria-components";
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
      <Button
        className="dropdown-item d-flex flex-column align-items-start min-w-0"
        onPress={() => onNavigate(bookmark.cfi)}
      >
        <span className="text-truncate w-100">
          {bookmark.preview || "Saved location"}
        </span>
        <span className="small text-muted">
          Page {bookmark.pageNumber ?? "unknown"}
        </span>
      </Button>
      <IconButton
        label="Delete bookmark"
        icon="x-lg"
        className="border-0 flex-shrink-0 compact-delete-button"
        isDisabled={bookmarkBusy}
        onPress={() => onRemove(bookmark.cfi)}
      />
    </div>
  );
}
