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
      className="bookmark-menu-row grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto] items-center overflow-hidden px-2"
    >
      <Button
        className="btn btn-ghost h-auto min-h-0 w-full min-w-0 max-w-none flex-col items-start gap-0 overflow-hidden px-2 py-1 font-normal"
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
        className="btn-ghost relative z-10 border-0 compact-delete-button"
        isDisabled={bookmarkBusy}
        onPress={() => onRemove(bookmark.cfi)}
      />
    </GridListItem>
  );
}
