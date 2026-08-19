import { useMemo } from "react";
import {
  Button,
  Header,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Separator,
} from "react-aria-components";
import type { LibraryBook } from "../../data/libraryDb";
import { classNames } from "../../util/classNames";
import { browseEntries, recentBookCount } from "./libraryModel";
import { DIMENSIONS, DIMENSION_LABEL, type LibraryView } from "./libraryView";

export function LibraryMenu(props: LibraryMenuProps) {
  const counts = useBrowseCounts(props.books);
  return (
    <MenuTrigger>
      <LibraryMenuTrigger />
      <LibraryMenuPopover {...props} counts={counts} />
    </MenuTrigger>
  );
}

interface LibraryMenuProps {
  books: LibraryBook[];
  view: LibraryView;
  displayName: string;
  onNavigate: (view: LibraryView) => void;
  onLock: () => void;
}

interface LibraryMenuItemsProps extends LibraryMenuProps {
  counts: Record<(typeof DIMENSIONS)[number], number>;
}

function LibraryMenuTrigger() {
  return (
    <Button
      className="btn btn-sm btn-outline-secondary dropdown-toggle d-flex align-items-center gap-2"
      aria-label="Library menu"
    >
      <i className="bi bi-book" aria-hidden="true" />
      <span className="d-none d-md-inline fw-semibold">Skypiea</span>
    </Button>
  );
}

function LibraryMenuPopover(props: LibraryMenuItemsProps) {
  return (
    <Popover
      placement="bottom start"
      offset={4}
      className="dropdown-menu show library-menu p-0"
    >
      <LibraryMenuItems {...props} />
    </Popover>
  );
}

function LibraryMenuItems(props: LibraryMenuItemsProps) {
  const { books, view, onNavigate } = props;
  const current = selectedKey(view);
  return (
    <Menu className="py-1">
      <NavigationItem
        id="recent"
        label="Recent"
        count={recentBookCount(books)}
        active={current === "recent"}
        onAction={() => onNavigate({ kind: "recent" })}
      />
      <BrowseMenuSection {...props} current={current} />
      <Separator className="dropdown-divider" />
      <AccountMenuSection {...props} />
    </Menu>
  );
}

function BrowseMenuSection({
  books,
  counts,
  current,
  onNavigate,
}: LibraryMenuItemsProps & { current: string }) {
  return (
    <MenuSection>
      <Header className="dropdown-header">Browse</Header>
      <NavigationItem
        id="all"
        label="All Books"
        count={books.length}
        active={current === "all"}
        onAction={() => onNavigate({ kind: "books", filter: null })}
      />
      {DIMENSIONS.map((dimension) => (
        <NavigationItem
          key={dimension}
          id={dimension}
          label={DIMENSION_LABEL[dimension]}
          count={counts[dimension]}
          active={current === dimension}
          onAction={() => onNavigate({ kind: "entries", dimension })}
        />
      ))}
    </MenuSection>
  );
}

function AccountMenuSection({ displayName, onLock }: LibraryMenuProps) {
  return (
    <MenuSection>
      <Header className="dropdown-header text-truncate">
        <i className="bi bi-person-circle me-2" aria-hidden="true" />
        {displayName}
      </Header>
      <MenuItem
        id="lock"
        textValue="Lock"
        className="dropdown-item d-flex align-items-center gap-2"
        onAction={onLock}
      >
        <i className="bi bi-lock" aria-hidden="true" />
        Lock
      </MenuItem>
    </MenuSection>
  );
}

function NavigationItem({
  id,
  label,
  count,
  active,
  onAction,
}: {
  id: string;
  label: string;
  count: number;
  active: boolean;
  onAction: () => void;
}) {
  return (
    <MenuItem
      id={id}
      textValue={label}
      aria-label={`${label}, ${count}${active ? ", current" : ""}`}
      className={classNames(
        "dropdown-item d-flex justify-content-between align-items-center gap-3",
        active && "active",
      )}
      onAction={onAction}
    >
      <span>{label}</span>
      <CountBadge count={count} active={active} />
    </MenuItem>
  );
}

function CountBadge({ count, active }: { count: number; active: boolean }) {
  return (
    <span
      className={classNames(
        "badge rounded-pill",
        active ? "text-bg-light" : "text-bg-dark",
      )}
    >
      {count}
    </span>
  );
}

function useBrowseCounts(books: LibraryBook[]) {
  return useMemo(
    () =>
      Object.fromEntries(
        DIMENSIONS.map((dimension) => [
          dimension,
          browseEntries(books, dimension).length,
        ]),
      ) as Record<(typeof DIMENSIONS)[number], number>,
    [books],
  );
}

function selectedKey(view: LibraryView): string {
  if (view.kind === "recent") return "recent";
  if (view.kind === "entries") return view.dimension;
  return view.filter?.dimension ?? "all";
}
