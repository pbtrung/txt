// A "list-group list-group-flush" that only ever mounts the rows currently
// scrolled into view (plus a small overscan buffer), regardless of how
// many `items` it's given -- so Library's book/browse lists stay cheap to
// render as an account's library grows, on top of the memoized sort/filter
// work already done before they get here (see libraryModel.ts).
//
// Owns its own scroll container (a bounded-height box that scrolls
// independently) rather than attaching to an ambient page scroll --
// @tanstack/react-virtual needs a concrete viewport to compute which rows
// are actually visible, and Library's Recent view in particular stacks two
// of these (Continue Reading, Recent Bookmarks) side by side vertically,
// so each needs its own bounded region rather than sharing one unbounded
// page scroll the way the plain (pre-virtualization) list did.
//
// Row height is a plain constant per call site, not measured per-row:
// every row this renders (BookRow, BookmarkRow, the browse-entry row) uses
// text-truncate/overflow-hidden rather than wrapping, so its rendered
// height is already constant regardless of content -- no need for
// @tanstack/react-virtual's dynamic measureElement path.
//
// Each visible row is positioned by cloning renderRow's returned element
// with an injected style (rather than wrapping it in an extra div): the
// row components (BookRow/BookmarkRow, both via ClickableRow; the raw
// browse-entry <button>) already render the actual `.list-group-item`
// element as their own root, so cloning keeps that element a direct child
// of `.list-group-flush` -- an intervening wrapper div would instead make
// it a grandchild, breaking Bootstrap's `.list-group-flush > .list-group-item`
// and `.list-group-item + .list-group-item` selectors (the borders between
// rows) since those rely on direct-child/adjacent-sibling relationships.

import {
  cloneElement,
  useRef,
  type CSSProperties,
  type ReactElement,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface VirtualizedListGroupProps<T> {
  items: T[];
  getKey: (item: T) => string | number;
  renderRow: (item: T) => ReactElement<{ style?: CSSProperties }>;
  estimateRowHeight: number;
  emptyMessage: string;
  className?: string;
  style?: CSSProperties;
}

export function VirtualizedListGroup<T>({
  items,
  getKey,
  renderRow,
  estimateRowHeight,
  emptyMessage,
  className,
  style,
}: VirtualizedListGroupProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 8,
  });

  if (items.length === 0) {
    return <p className="text-body-secondary p-3">{emptyMessage}</p>;
  }

  return (
    <div
      ref={scrollRef}
      className={`overflow-auto ${className ?? ""}`}
      style={{ minHeight: 0, ...style }}
    >
      <div
        className="list-group list-group-flush position-relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          return cloneElement(renderRow(item), {
            key: getKey(item),
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start}px)`,
            },
          });
        })}
      </div>
    </div>
  );
}
