// Loads the book's table of contents once a renderer exists, letting each
// entry jump straight to that section.
import type { NavItem } from "@likecoin/epub-ts";
import { useEffect, useState } from "react";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import type { EpubRenderer, PagePosition } from "../../data/epubRenderer";

export function TocPanel({
  open,
  onClose,
  renderer,
  page,
  onDecreaseFont,
  onIncreaseFont,
}: {
  open: boolean;
  onClose: () => void;
  renderer: EpubRenderer | null;
  page: PagePosition;
  onDecreaseFont: () => void;
  onIncreaseFont: () => void;
}) {
  const [toc, setToc] = useState<NavItem[] | null>(null);

  useEffect(() => {
    if (!renderer) return;
    let cancelled = false;
    renderer.getToc().then((items) => {
      if (!cancelled) setToc(items);
    });
    return () => {
      cancelled = true;
    };
  }, [renderer]);

  function goTo(href: string) {
    void renderer?.display(href);
    onClose();
  }

  return (
    <OffcanvasPanel
      open={open}
      onClose={onClose}
      title="Menu"
      placement="start"
      className="reader-side-panel"
    >
      <MenuControls
        renderer={renderer}
        page={page}
        onDecreaseFont={onDecreaseFont}
        onIncreaseFont={onIncreaseFont}
      />
      <h2 className="h6">Contents</h2>
      {toc === null ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <TocList items={toc} onSelect={goTo} />
      )}
    </OffcanvasPanel>
  );
}

function MenuControls({
  renderer,
  page,
  onDecreaseFont,
  onIncreaseFont,
}: {
  renderer: EpubRenderer | null;
  page: PagePosition;
  onDecreaseFont: () => void;
  onIncreaseFont: () => void;
}) {
  return (
    <div className="border-bottom mb-3 pb-3">
      <div className="d-flex align-items-center justify-content-between mb-3">
        <span className="small text-muted">Font size</span>
        <div>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            aria-label="Decrease font size"
            onClick={onDecreaseFont}
          >
            <i className="bi bi-dash" />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary ms-1"
            aria-label="Increase font size"
            onClick={onIncreaseFont}
          >
            <i className="bi bi-plus" />
          </button>
        </div>
      </div>
      <PageNavigation renderer={renderer} page={page} />
    </div>
  );
}

function PageNavigation({
  renderer,
  page,
}: {
  renderer: EpubRenderer | null;
  page: PagePosition;
}) {
  return (
    <div className="d-flex align-items-center justify-content-between gap-2">
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        aria-label="Previous page"
        disabled={!renderer}
        onClick={() => void renderer?.prev()}
      >
        <i className="bi bi-chevron-left" />
      </button>
      <span
        className="small text-muted text-center"
        aria-label={`Page ${page.current} of ${page.total}`}
        aria-live="polite"
      >
        {page.current} / {page.total}
      </span>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        aria-label="Next page"
        disabled={!renderer}
        onClick={() => void renderer?.next()}
      >
        <i className="bi bi-chevron-right" />
      </button>
    </div>
  );
}

function TocList({
  items,
  onSelect,
}: {
  items: NavItem[];
  onSelect: (href: string) => void;
}) {
  return (
    <ul className="list-unstyled ps-0">
      {items.map((item) => (
        <li key={item.id} className="mb-1">
          <button
            type="button"
            className="btn btn-link p-0 text-start text-decoration-none"
            onClick={() => onSelect(item.href)}
          >
            {item.label.trim()}
          </button>
          {item.subitems && item.subitems.length > 0 && (
            <div className="ps-3">
              <TocList items={item.subitems} onSelect={onSelect} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
