// Loads the book's table of contents once a renderer exists, letting each
// entry jump straight to that section.
import type { NavItem } from "@likecoin/epub-ts";
import { useEffect, useState } from "react";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import type { EpubRenderer } from "../../data/epubRenderer";

export function TocPanel({
  open,
  onClose,
  renderer,
}: {
  open: boolean;
  onClose: () => void;
  renderer: EpubRenderer | null;
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
      style={{ width: "20rem", maxWidth: "100%" }}
    >
      {toc === null ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <TocList items={toc} onSelect={goTo} />
      )}
    </OffcanvasPanel>
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
