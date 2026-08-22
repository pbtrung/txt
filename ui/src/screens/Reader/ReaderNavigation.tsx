import {
  Button,
  Dialog,
  DialogTrigger,
  GridList,
  Input,
  Menu,
  MenuItem,
  MenuTrigger,
  NumberField,
  Popover,
} from "react-aria-components";
import { Bookmark, BookmarkMinus, BookmarkPlus } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import type { DatabaseStoreStatus } from "../../data/databaseStore";
import type { EpubRenderer, PagePosition } from "../../data/epubRenderer";
import type { BookmarkRecord } from "../../data/readingState";
import { classNames } from "../../util/classNames";
import { BookmarkRow } from "./BookmarkRow";

const FONT_SIZES_PX = [16, 18, 20, 22] as const;

export function ReaderNavigation({
  renderer,
  page,
  fontPx,
  onFontSize,
  bookmarkSaved,
  bookmarkBusy,
  bookmarks,
  status,
  error,
  onBookmark,
  onRemove,
  onRetry,
}: {
  renderer: EpubRenderer | null;
  page: PagePosition;
  fontPx: number;
  onFontSize: (size: number) => void;
  bookmarkSaved: boolean;
  bookmarkBusy: boolean;
  bookmarks: BookmarkRecord[];
  status: DatabaseStoreStatus;
  error: string | null;
  onBookmark: () => void;
  onRemove: (cfi: string) => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center justify-start gap-2 border-t border-base-300 py-1">
      <FontSizeMenu value={fontPx} onChange={onFontSize} />
      <span
        className="divider divider-horizontal mx-0 h-5 reader-nav-divider"
        aria-hidden="true"
      />
      <IconButton
        label="Previous page"
        icon="chevron-left"
        isDisabled={!renderer}
        onPress={() => void renderer?.prev()}
      />
      <PageInput renderer={renderer} page={page} />
      <span
        className="text-sm text-base-content/60"
        aria-label={`Total pages ${page.total}`}
      >
        / {page.total}
      </span>
      <IconButton
        label="Next page"
        icon="chevron-right"
        isDisabled={!renderer}
        onPress={() => void renderer?.next()}
      />
      <BookmarkMenu
        {...{
          renderer,
          bookmarks,
          bookmarkSaved,
          bookmarkBusy,
          status,
          error,
          onBookmark,
          onRemove,
          onRetry,
        }}
      />
    </div>
  );
}

export function BookmarkMenu({
  renderer,
  bookmarks,
  bookmarkSaved,
  bookmarkBusy,
  status,
  error,
  onBookmark,
  onRemove,
  onRetry,
}: {
  renderer: EpubRenderer | null;
  bookmarks: BookmarkRecord[];
  bookmarkSaved: boolean;
  bookmarkBusy: boolean;
  status: DatabaseStoreStatus;
  error: string | null;
  onBookmark: () => void;
  onRemove: (cfi: string) => void;
  onRetry: () => void;
}) {
  return (
    <DialogTrigger>
      <Button
        className="btn btn-sm btn-square btn-outline btn-secondary ml-auto"
        aria-label="Bookmarks"
      >
        <Bookmark
          className="size-4"
          fill={bookmarkSaved ? "currentColor" : "none"}
          aria-hidden="true"
        />
      </Button>
      <Popover
        placement="top end"
        offset={0}
        className="menu rounded-box border border-base-300 bg-base-100 shadow-lg reader-bookmark-menu"
      >
        <Dialog
          aria-label="Bookmark options"
          className="w-full max-w-full overflow-hidden border-0 outline-none"
        >
          {({ close }) => (
            <BookmarkOptions
              {...{
                renderer,
                bookmarks,
                bookmarkSaved,
                bookmarkBusy,
                status,
                error,
                onRemove,
                onRetry,
              }}
              onBookmark={() => {
                onBookmark();
                close();
              }}
              onNavigate={(cfi) => {
                void renderer?.display(cfi);
                close();
              }}
            />
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function BookmarkOptions({
  renderer,
  bookmarks,
  bookmarkSaved,
  bookmarkBusy,
  status,
  error,
  onBookmark,
  onNavigate,
  onRemove,
  onRetry,
}: {
  renderer: EpubRenderer | null;
  bookmarks: BookmarkRecord[];
  bookmarkSaved: boolean;
  bookmarkBusy: boolean;
  status: DatabaseStoreStatus;
  error: string | null;
  onBookmark: () => void;
  onNavigate: (cfi: string) => void;
  onRemove: (cfi: string) => void;
  onRetry: () => void;
}) {
  return (
    <div className="w-full min-w-0 max-w-full overflow-hidden">
      <Button
        className="btn btn-ghost btn-sm h-auto min-h-0 w-full justify-start gap-2 font-normal"
        isDisabled={!renderer || bookmarkBusy}
        onPress={onBookmark}
      >
        {bookmarkSaved ? (
          <BookmarkMinus className="size-4" aria-hidden="true" />
        ) : (
          <BookmarkPlus className="size-4" aria-hidden="true" />
        )}
        {bookmarkSaved ? "Remove current bookmark" : "Add current bookmark"}
      </Button>
      <div className="divider my-1" />
      <BookmarkStatus {...{ status, error, onRetry }} />
      {bookmarks.length ? (
        <GridList
          aria-label="Saved bookmarks"
          className="bookmark-grid w-full min-w-0 max-w-full overflow-x-hidden"
        >
          {bookmarks.map((bookmark) => (
            <BookmarkRow
              key={bookmark.id}
              {...{ bookmark, bookmarkBusy, onNavigate, onRemove }}
            />
          ))}
        </GridList>
      ) : (
        <span className="block px-2 py-1 text-base-content/60">No bookmarks yet.</span>
      )}
    </div>
  );
}

function BookmarkStatus({
  status,
  error,
  onRetry,
}: {
  status: DatabaseStoreStatus;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="alert alert-error mx-2 block py-2 text-sm" role="alert">
        <span className="mb-1 block">Unsaved changes: {error}</span>
        <Button
          className="btn btn-sm btn-outline btn-error"
          isDisabled={status.pending}
          onPress={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }
  return status.pending ? (
    <span role="status" className="block px-2 py-1 text-sm text-base-content/60">
      Saving…
    </span>
  ) : null;
}

function FontSizeMenu({
  value,
  onChange,
}: {
  value: number;
  onChange: (size: number) => void;
}) {
  return (
    <MenuTrigger>
      <Button
        className="btn btn-sm btn-outline btn-secondary text-sm reader-font-trigger"
        aria-label="Font size"
      >
        {value}px
      </Button>
      <Popover
        placement="top start"
        offset={0}
        className="menu rounded-box border border-base-300 bg-base-100 p-0 text-sm shadow-lg reader-font-menu"
      >
        <FontSizeOptions value={value} onSelect={onChange} />
      </Popover>
    </MenuTrigger>
  );
}

function FontSizeOptions({
  value,
  onSelect,
}: {
  value: number;
  onSelect: (size: number) => void;
}) {
  return (
    <Menu
      aria-label="Font size options"
      selectionMode="single"
      selectedKeys={new Set([String(value)])}
      className="p-1 outline-none"
      onAction={(key) => onSelect(Number(key))}
    >
      {FONT_SIZES_PX.map((size) => (
        <MenuItem
          key={size}
          id={String(size)}
          textValue={`${size}px`}
          className={({ isSelected }) =>
            classNames(
              "cursor-pointer rounded-field px-3 py-2 text-sm outline-none hover:bg-base-200 focus:bg-base-200 reader-font-option",
              isSelected && "bg-primary text-primary-content hover:bg-primary",
            )
          }
        >
          {size}px
        </MenuItem>
      ))}
    </Menu>
  );
}

function PageInput({
  renderer,
  page,
}: {
  renderer: EpubRenderer | null;
  page: PagePosition;
}) {
  return (
    <NumberField
      aria-label="Current page"
      value={page.current}
      minValue={1}
      maxValue={page.total}
      step={1}
      isDisabled={!renderer}
      style={{ width: `calc(${String(page.total).length}ch + 1.5rem)` }}
      onChange={(target) => void renderer?.displayPage(target)}
    >
      <Input className="input input-sm w-full text-right text-sm reader-page-input" />
    </NumberField>
  );
}
