// Loads the book's table of contents once a renderer exists, letting each
// entry jump straight to that section.
import type { NavItem } from "@likecoin/epub-ts";
import { useEffect, useState } from "react";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import type { EpubRenderer } from "../../data/epubRenderer";

interface LoadedToc {
  renderer: EpubRenderer;
  items: NavItem[] | null;
}

export function TocPanel({
  open,
  onClose,
  renderer,
}: {
  open: boolean;
  onClose: () => void;
  renderer: EpubRenderer | null;
}) {
  const [loaded, setLoaded] = useState<LoadedToc | null>(null);
  useEffect(() => {
    if (!renderer) return;
    const source = renderer;
    let cancelled = false;
    source
      .getToc()
      .then((items) => setUnlessCancelled(items))
      .catch(() => setUnlessCancelled(null));
    function setUnlessCancelled(items: NavItem[] | null) {
      if (!cancelled) setLoaded({ renderer: source, items });
    }
    return () => {
      cancelled = true;
    };
  }, [renderer]);
  const toc = loaded?.renderer === renderer ? loaded.items : undefined;
  return (
    <OffcanvasPanel
      open={open}
      onClose={onClose}
      title="Content"
      placement="start"
      className="reader-side-panel"
    >
      {toc === undefined ? (
        <p className="text-muted">Loading…</p>
      ) : toc === null ? (
        <p role="alert" className="text-danger">
          Unable to load contents.
        </p>
      ) : toc.length === 0 ? (
        <p className="text-muted">No contents available.</p>
      ) : (
        <TocList
          items={toc}
          onSelect={(href) => {
            void renderer?.display(href);
            onClose();
          }}
        />
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
