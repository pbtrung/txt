import { useState } from "react";
import {
  Button,
  Dialog,
  DialogTrigger,
  Input,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
} from "react-aria-components";
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
    <div className="d-flex align-items-center justify-content-start border-top py-1 gap-2">
      <FontSizeMenu value={fontPx} onChange={onFontSize} />
      <span className="vr" aria-hidden="true" />
      <IconButton
        label="Previous page"
        icon="chevron-left"
        isDisabled={!renderer}
        onPress={() => void renderer?.prev()}
      />
      <PageInput renderer={renderer} page={page} />
      <span className="small text-muted" aria-label={`Total pages ${page.total}`}>
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
        className="btn btn-sm btn-outline-secondary ms-auto"
        aria-label="Bookmarks"
      >
        <i
          className={`bi bi-${bookmarkSaved ? "bookmark-fill" : "bookmark"}`}
          aria-hidden="true"
        />
      </Button>
      <Popover
        placement="top end"
        offset={0}
        className="dropdown-menu show reader-bookmark-menu"
      >
        <Dialog aria-label="Bookmark options" className="border-0">
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
    <div>
      <Button
        className="dropdown-item d-flex align-items-center gap-2"
        isDisabled={!renderer || bookmarkBusy}
        onPress={onBookmark}
      >
        <i
          className={`bi bi-${bookmarkSaved ? "bookmark-dash" : "bookmark-plus"}`}
          aria-hidden="true"
        />
        {bookmarkSaved ? "Remove current bookmark" : "Add current bookmark"}
      </Button>
      <div className="dropdown-divider" />
      <BookmarkStatus {...{ status, error, onRetry }} />
      {bookmarks.length ? (
        bookmarks.map((bookmark) => (
          <BookmarkRow
            key={bookmark.id}
            {...{ bookmark, bookmarkBusy, onNavigate, onRemove }}
          />
        ))
      ) : (
        <span className="dropdown-item-text text-muted">No bookmarks yet.</span>
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
      <div className="alert alert-danger py-2 mx-2 small" role="alert">
        <span className="d-block mb-1">Unsaved changes: {error}</span>
        <Button
          className="btn btn-sm btn-outline-danger"
          isDisabled={status.pending}
          onPress={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }
  return status.pending ? (
    <span role="status" className="dropdown-item-text small text-muted">
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
        className="btn btn-sm btn-outline-secondary dropdown-toggle"
        aria-label="Font size"
      >
        {value}px
      </Button>
      <Popover
        placement="top start"
        offset={0}
        className="dropdown-menu show reader-font-menu p-0"
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
      className="py-1"
      onAction={(key) => onSelect(Number(key))}
    >
      {FONT_SIZES_PX.map((size) => (
        <MenuItem
          key={size}
          id={String(size)}
          textValue={`${size}px`}
          className={({ isSelected }) =>
            classNames("dropdown-item", isSelected && "active")
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
  const [draft, setDraft] = useState({
    page: page.current,
    value: String(page.current),
  });
  const value = draft.page === page.current ? draft.value : String(page.current);
  const submit = () => {
    const target = Number(value);
    if (Number.isInteger(target) && target >= 1 && target <= page.total) {
      void renderer?.displayPage(target);
    } else {
      setDraft({ page: page.current, value: String(page.current) });
    }
  };
  return (
    <Input
      type="text"
      inputMode="numeric"
      className="form-control form-control-sm text-end"
      aria-label="Current page"
      value={value}
      disabled={!renderer}
      style={{ width: `calc(${String(page.total).length}ch + 1.5rem)` }}
      onChange={(event) => setDraft({ page: page.current, value: event.target.value })}
      onBlur={submit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
