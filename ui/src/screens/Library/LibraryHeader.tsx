import { IconButton } from "../../components/IconButton";

export function LibraryHeader({
  query,
  onQuery,
  onOpenMenu,
}: {
  query: string;
  onQuery: (query: string) => void;
  onOpenMenu: () => void;
}) {
  return (
    <div className="d-flex align-items-center border-bottom flex-shrink-0">
      <LibraryBrand onOpenMenu={onOpenMenu} />
      <div className="flex-grow-1 px-2 px-md-3 py-2">
        <div className="search-box position-relative">
          <i className="bi bi-search search-box-icon" aria-hidden="true" />
          <input
            type="search"
            className="form-control form-control-sm search-box-input"
            placeholder="Search…"
            aria-label="Search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function LibraryBrand({ onOpenMenu }: { onOpenMenu: () => void }) {
  return (
    <div className="d-flex align-items-center gap-2 px-2 px-md-3 py-2 library-brand-col">
      <IconButton
        className="d-md-none"
        label="Open menu"
        icon="book"
        onClick={onOpenMenu}
      />
      <div className="d-none d-md-flex align-items-center gap-2">
        <i className="bi bi-book fs-5" aria-hidden="true" />
        <span className="fw-semibold fs-5">Skypiea</span>
      </div>
    </div>
  );
}
