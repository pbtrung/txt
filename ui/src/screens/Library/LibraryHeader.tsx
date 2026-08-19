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
      <div className="px-2 py-2">{menu}</div>
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
              <i className="bi bi-x-lg" aria-hidden="true" />
            </Button>
          )}
        </SearchField>
      </div>
    </div>
  );
}
