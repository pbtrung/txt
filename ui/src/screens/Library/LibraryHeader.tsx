import type { ReactNode } from "react";
import { Button, Input, SearchField } from "react-aria-components";

export function LibraryHeader({
  query,
  onQuery,
  menu,
}: {
  query: string;
  onQuery: (query: string) => void;
  menu: ReactNode;
}) {
  return (
    <div className="d-flex align-items-center border-bottom flex-shrink-0">
      <div className="d-flex align-items-center gap-2 px-2 px-md-3 py-2 library-brand-col">
        {menu}
        <div className="d-none d-md-flex align-items-center gap-2">
          <i className="bi bi-book fs-5" aria-hidden="true" />
          <span className="fw-semibold fs-5">Skypiea</span>
        </div>
      </div>
      <div className="flex-grow-1 px-2 px-md-3 py-2">
        <SearchField
          className="search-box position-relative"
          aria-label="Search"
          value={query}
          onChange={onQuery}
        >
          <i className="bi bi-search search-box-icon" aria-hidden="true" />
          <Input
            className="form-control form-control-sm search-box-input"
            placeholder="Search…"
          />
          {query && (
            <Button className="search-box-clear" aria-label="Clear search">
              <span className="search-box-clear-icon" aria-hidden="true">
                ×
              </span>
            </Button>
          )}
        </SearchField>
      </div>
    </div>
  );
}
