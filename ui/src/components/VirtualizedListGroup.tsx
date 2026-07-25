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

import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface VirtualizedListGroupProps<T> {
  items: T[];
  getKey: (item: T) => string | number;
  renderRow: (item: T) => ReactNode;
  estimateRowHeight: number;
  emptyMessage: string;
  className?: string;
}

export function VirtualizedListGroup<T>({
  items,
  getKey,
  renderRow,
  estimateRowHeight,
  emptyMessage,
  className,
}: VirtualizedListGroupProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 8,
  });

  if (items.length === 0) {
    return <p className="text-body-secondary px-3 pb-3">{emptyMessage}</p>;
  }

  return (
    <div ref={scrollRef} className={`overflow-auto ${className ?? ""}`} style={{ minHeight: 0 }}>
      <div className="list-group list-group-flush position-relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={getKey(items[virtualRow.index])}
            className="position-absolute top-0 start-0 w-100"
            style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}
          >
            {renderRow(items[virtualRow.index])}
          </div>
        ))}
      </div>
    </div>
  );
}
