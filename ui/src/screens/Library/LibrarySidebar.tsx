import { useMemo } from "react";
import { UserCircle } from "lucide-react";
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
    <div className="library-sidebar-content flex h-full w-full flex-col">
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
    <nav className="flex-1 overflow-y-auto pt-2" aria-label="Library">
      <div className="flex flex-col">
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
        <div className="px-3 pt-3 pb-1 text-xs font-semibold uppercase text-base-content/60">
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
        "btn btn-ghost h-auto min-h-0 w-full justify-between rounded-none px-3 py-2 font-normal",
        active && "btn-active bg-primary text-primary-content",
      )}
      onPress={onPress}
    >
      {label}
      <span className="badge badge-sm border border-base-300 bg-base-200 text-base-content">
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
    <div className="flex shrink-0 items-center justify-between border-t border-base-300 p-2">
      <span className="flex min-w-0 items-center gap-2 truncate">
        <UserCircle className="size-5 shrink-0" aria-hidden="true" />
        <span className="truncate text-sm">{displayName}</span>
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
