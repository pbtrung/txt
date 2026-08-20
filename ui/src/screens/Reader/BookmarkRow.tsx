import { IconButton } from "../../components/IconButton";
import { Button, GridListItem } from "react-aria-components";
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
  const label = bookmark.preview || "Saved location";
  return (
    <GridListItem
      id={bookmark.id}
      textValue={label}
      focusMode="child"
      className="bookmark-menu-row flex items-center px-2"
    >
      <Button
        className="btn btn-ghost h-auto min-h-0 min-w-0 flex-1 flex-col items-start gap-0 px-2 py-1 font-normal"
        onPress={() => onNavigate(bookmark.cfi)}
      >
        <span className="w-full truncate text-left">{label}</span>
        <span className="text-sm text-base-content/60">
          Page {bookmark.pageNumber ?? "unknown"}
        </span>
      </Button>
      <IconButton
        label="Delete bookmark"
        icon="x-lg"
        className="btn-ghost shrink-0 border-0 compact-delete-button"
        isDisabled={bookmarkBusy}
        onPress={() => onRemove(bookmark.cfi)}
      />
    </GridListItem>
  );
}
