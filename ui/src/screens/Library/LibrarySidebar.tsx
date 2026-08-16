import { useMemo } from "react";
import { IconButton } from "../../components/IconButton";
import type { LibraryBook } from "../../data/libraryDb";
import { classNames } from "../../util/classNames";
import { browseEntries, type BrowseDimension } from "./libraryModel";
import { DIMENSIONS, DIMENSION_LABEL, type LibraryView } from "./libraryView";

export function LibrarySidebar({
  books,
  view,
  displayName,
  onNavigate,
  onLock,
}: {
  books: LibraryBook[];
  view: LibraryView;
  displayName: string;
  onNavigate: (view: LibraryView) => void;
  onLock: () => void;
}) {
  return (
    <div className="d-flex flex-column h-100 w-100">
      <LibraryNav books={books} view={view} onNavigate={onNavigate} />
      <AccountRow displayName={displayName} onLock={onLock} />
    </div>
  );
}

function LibraryNav({
  books,
  view,
  onNavigate,
}: {
  books: LibraryBook[];
  view: LibraryView;
  onNavigate: (view: LibraryView) => void;
}) {
  const counts = useMemo(
    () =>
      Object.fromEntries(
        DIMENSIONS.map((dimension) => [
          dimension,
          browseEntries(books, dimension).length,
        ]),
      ) as Record<BrowseDimension, number>,
    [books],
  );
  return (
    <nav className="flex-grow-1 overflow-y-auto pt-2" aria-label="Library">
      <div className="list-group list-group-flush">
        <NavRow
          label="All Books"
          count={books.length}
          active={view.kind === "books" && view.filter === null}
          onClick={() => onNavigate({ kind: "books", filter: null })}
        />
        {DIMENSIONS.map((dimension) => (
          <DimensionRow
            key={dimension}
            view={view}
            dimension={dimension}
            count={counts[dimension]}
            onNavigate={onNavigate}
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
      onClick={() => onNavigate({ kind: "entries", dimension })}
    />
  );
}

function NavRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={classNames(
        "list-group-item list-group-item-action d-flex justify-content-between align-items-center",
        active && "active",
      )}
      onClick={onClick}
    >
      {label}
      <span
        className={classNames(
          "badge rounded-pill",
          active ? "text-bg-light" : "text-bg-secondary",
        )}
      >
        {count}
      </span>
    </button>
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
      <IconButton label="Lock" icon="lock" onClick={onLock} />
    </div>
  );
}
