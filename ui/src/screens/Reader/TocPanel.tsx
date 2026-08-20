// Loads the book's table of contents once a renderer exists, letting each
// entry jump straight to that section.
import type { NavItem } from "@likecoin/epub-ts";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import { DrawerPanel } from "../../components/DrawerPanel";
import type { EpubRenderer } from "../../data/epubRenderer";

interface LoadedToc {
  renderer: EpubRenderer;
  items: NavItem[] | null;
}

export function TocPanel({
  open,
  onClose,
  renderer,
  portalContainer,
}: {
  open: boolean;
  onClose: () => void;
  renderer: EpubRenderer | null;
  portalContainer?: Element;
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
    <DrawerPanel
      open={open}
      onClose={onClose}
      title="Content"
      placement="start"
      className="reader-side-panel"
      overlayClassName="reader-drawer-overlay"
      portalContainer={portalContainer}
    >
      {toc === undefined ? (
        <p className="text-base-content/60">Loading…</p>
      ) : toc === null ? (
        <p role="alert" className="text-error">
          Unable to load contents.
        </p>
      ) : toc.length === 0 ? (
        <p className="text-base-content/60">No contents available.</p>
      ) : (
        <TocList
          items={toc}
          onSelect={(href) => {
            void renderer?.display(href);
            onClose();
          }}
        />
      )}
    </DrawerPanel>
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
    <Tree
      aria-label="Table of contents"
      className="toc-tree"
      defaultExpandedKeys={tocBranchKeys(items)}
    >
      {items.map((item) => (
        <TocTreeItem key={item.id} item={item} path={item.id} onSelect={onSelect} />
      ))}
    </Tree>
  );
}

function TocTreeItem({
  item,
  path,
  onSelect,
}: {
  item: NavItem;
  path: string;
  onSelect: (href: string) => void;
}) {
  const label = item.label.trim();
  return (
    <TreeItem
      id={path}
      textValue={label}
      className="toc-tree-item"
      onAction={() => onSelect(item.href)}
    >
      <TreeItemContent>
        {({ hasChildItems, isExpanded, level }) => (
          <span
            className="toc-tree-row flex items-start gap-1"
            style={{ paddingInlineStart: `${level - 1}rem` }}
          >
            {hasChildItems ? (
              <Button
                slot="chevron"
                className="btn btn-ghost btn-sm min-h-0 shrink-0 border-0 p-0 toc-tree-chevron"
              >
                {isExpanded ? (
                  <ChevronDown className="size-4" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-4" aria-hidden="true" />
                )}
              </Button>
            ) : (
              <span className="toc-tree-chevron" aria-hidden="true" />
            )}
            <span className="cursor-pointer text-left text-primary hover:underline">
              {label}
            </span>
          </span>
        )}
      </TreeItemContent>
      {item.subitems?.map((child) => (
        <TocTreeItem
          key={child.id}
          item={child}
          path={`${path}/${child.id}`}
          onSelect={onSelect}
        />
      ))}
    </TreeItem>
  );
}

function tocBranchKeys(items: NavItem[], parent = ""): string[] {
  return items.flatMap((item) => {
    const path = parent ? `${parent}/${item.id}` : item.id;
    return item.subitems?.length ? [path, ...tocBranchKeys(item.subitems, path)] : [];
  });
}
