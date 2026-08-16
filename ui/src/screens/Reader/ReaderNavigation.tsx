import { useEffect, useRef, useState } from "react";
import { IconButton } from "../../components/IconButton";
import type { EpubRenderer, PagePosition } from "../../data/epubRenderer";
import { classNames } from "../../util/classNames";

const FONT_SIZES_PX = [16, 18, 20, 22, 24] as const;

export function ReaderNavigation({
  renderer,
  page,
  fontPx,
  onFontSize,
}: {
  renderer: EpubRenderer | null;
  page: PagePosition;
  fontPx: number;
  onFontSize: (size: number) => void;
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
      <IconButton className="ms-auto" label="Bookmark" icon="bookmark" />
    </div>
  );
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
