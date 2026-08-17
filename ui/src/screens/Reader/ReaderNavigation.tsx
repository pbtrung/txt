import { useEffect, useRef, useState } from "react";
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
        disabled={!renderer}
        onClick={() => void renderer?.prev()}
      />
      <PageInput renderer={renderer} page={page} />
      <span className="small text-muted" aria-label={`Total pages ${page.total}`}>
        / {page.total}
      </span>
      <IconButton
        label="Next page"
        icon="chevron-right"
        disabled={!renderer}
        onClick={() => void renderer?.next()}
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissibleMenu(open, rootRef, () => setOpen(false));
  return (
    <div className="dropup ms-auto" ref={rootRef}>
      <IconButton
        label="Bookmarks"
        icon={bookmarkSaved ? "bookmark-fill" : "bookmark"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      <BookmarkOptions
        {...{
          open,
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
          setOpen(false);
        }}
        onNavigate={(cfi) => {
          void renderer?.display(cfi);
          setOpen(false);
        }}
      />
    </div>
  );
}

function BookmarkOptions({
  open,
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
  open: boolean;
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
    <div
      role="menu"
      aria-label="Bookmark options"
      className={classNames("dropdown-menu reader-bookmark-menu", open && "show")}
    >
      <button
        type="button"
        role="menuitem"
        className="dropdown-item d-flex align-items-center gap-2"
        disabled={!renderer || bookmarkBusy}
        onClick={onBookmark}
      >
        <i
          className={`bi bi-${bookmarkSaved ? "bookmark-dash" : "bookmark-plus"}`}
          aria-hidden="true"
        />
        {bookmarkSaved ? "Remove current bookmark" : "Add current bookmark"}
      </button>
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
        <button
          type="button"
          className="btn btn-sm btn-outline-danger"
          disabled={status.pending}
          onClick={onRetry}
        >
          Retry
        </button>
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissibleMenu(open, rootRef, () => setOpen(false));
  return (
    <div className="dropup" ref={rootRef}>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary dropdown-toggle"
        aria-label="Font size"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {value}px
      </button>
      <FontSizeOptions
        open={open}
        value={value}
        onSelect={(size) => {
          onChange(size);
          setOpen(false);
        }}
      />
    </div>
  );
}

function FontSizeOptions({
  open,
  value,
  onSelect,
}: {
  open: boolean;
  value: number;
  onSelect: (size: number) => void;
}) {
  return (
    <ul
      role="menu"
      className={classNames("dropdown-menu reader-font-menu", open && "show")}
      aria-label="Font size options"
    >
      {FONT_SIZES_PX.map((size) => (
        <li key={size}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === size}
            className={classNames("dropdown-item", value === size && "active")}
            onClick={() => onSelect(size)}
          >
            {size}px
          </button>
        </li>
      ))}
    </ul>
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
    <input
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

function useDismissibleMenu(
  open: boolean,
  rootRef: React.RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, rootRef, close]);
}
