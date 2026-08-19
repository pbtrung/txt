import { useMemo } from "react";
import { Button } from "react-aria-components";
import { IconButton } from "../../components/IconButton";
import type { LibraryBook } from "../../data/libraryDb";
import type { BookShare } from "../../data/shares";
import { classNames } from "../../util/classNames";
import { browseEntries, recentBookCount, type BrowseDimension } from "./libraryModel";
import { DIMENSIONS, DIMENSION_LABEL, type LibraryView } from "./libraryView";

export function LibrarySidebar({
  books,
  view,
  displayName,
  onNavigate,
  onLock,
  shares,
  isAdmin,
}: {
  books: LibraryBook[];
  view: LibraryView;
  displayName: string;
  onNavigate: (view: LibraryView) => void;
  onLock: () => void;
  shares: BookShare[];
  isAdmin: boolean;
}) {
  return (
    <div className="library-sidebar-content d-flex flex-column h-100 w-100">
      <LibraryNav {...{ books, view, onNavigate, shares, isAdmin }} />
      <AccountRow displayName={displayName} onLock={onLock} />
    </div>
  );
}

function LibraryNav({
  books,
  view,
  onNavigate,
  shares,
  isAdmin,
}: {
  books: LibraryBook[];
  view: LibraryView;
  onNavigate: (view: LibraryView) => void;
  shares: BookShare[];
  isAdmin: boolean;
}) {
  const counts = useBrowseCounts(books);
  return (
    <nav className="flex-grow-1 overflow-y-auto pt-2" aria-label="Library">
      <div className="list-group list-group-flush">
        <NavRow
          label="Recent"
          count={recentBookCount(books)}
          active={view.kind === "recent"}
          onPress={() => onNavigate({ kind: "recent" })}
        />
        {isAdmin && (
          <NavRow
            label="Shares"
            count={shares.length}
            active={view.kind === "shares"}
            onPress={() => onNavigate({ kind: "shares" })}
          />
        )}
        <div className="px-3 pt-3 pb-1 small fw-semibold text-uppercase text-muted">
          Browse
        </div>
        <NavRow
          label="All Books"
          count={books.length}
          active={view.kind === "books" && view.filter === null}
          onPress={() => onNavigate({ kind: "books", filter: null })}
        />
        {DIMENSIONS.map((dimension) => (
          <DimensionRow
            key={dimension}
            {...{ view, dimension, onNavigate }}
            count={counts[dimension]}
          />
        ))}
      </div>
    </nav>
  );
}

function DimensionRow({
  view,
  dimension,
  count,
  onNavigate,
}: {
  view: LibraryView;
  dimension: BrowseDimension;
  count: number;
  onNavigate: (view: LibraryView) => void;
}) {
  const active =
    (view.kind === "entries" && view.dimension === dimension) ||
    (view.kind === "books" && view.filter?.dimension === dimension);
  return (
    <NavRow
      label={DIMENSION_LABEL[dimension]}
      count={count}
      active={active}
      onPress={() => onNavigate({ kind: "entries", dimension })}
    />
  );
}

function NavRow({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      className={classNames(
        "list-group-item list-group-item-action d-flex justify-content-between align-items-center",
        active && "active",
      )}
      onPress={onPress}
    >
      {label}
      <span
        className={classNames(
          "badge rounded-pill",
          active ? "text-bg-light" : "text-bg-dark",
        )}
      >
        {count}
      </span>
    </Button>
  );
}

function AccountRow({
  displayName,
  onLock,
}: {
  displayName: string;
  onLock: () => void;
}) {
  return (
    <div className="d-flex align-items-center justify-content-between border-top p-2 flex-shrink-0">
      <span className="d-flex align-items-center gap-2 text-truncate">
        <i className="bi bi-person-circle fs-5" aria-hidden="true" />
        <span className="text-truncate small">{displayName}</span>
      </span>
      <IconButton label="Lock" icon="lock" onPress={onLock} />
    </div>
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
      ) as Record<BrowseDimension, number>,
    [books],
  );
}
