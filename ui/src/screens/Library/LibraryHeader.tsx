import type { ReactNode } from "react";
import {
  Button,
  Input,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  SearchField,
} from "react-aria-components";
import type { LibraryBook } from "../../data/libraryDb";

export function LibraryHeader({
  query,
  onQuery,
  menu,
  shareBooks = [],
  onShare = () => undefined,
}: {
  query: string;
  onQuery: (query: string) => void;
  menu: ReactNode;
  shareBooks?: LibraryBook[];
  onShare?: (txtId: number) => void;
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
      <div className="d-flex flex-grow-1 gap-2 px-2 px-md-3 py-2">
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
          <Button className="search-box-clear" aria-label="Clear search">
            <span className="search-box-clear-icon" aria-hidden="true">
              ×
            </span>
          </Button>
        </SearchField>
        {shareBooks.length > 0 && (
          <MenuTrigger>
            <Button className="btn btn-sm btn-outline-secondary flex-shrink-0">
              <i className="bi bi-share me-1" aria-hidden="true" />
              Share
            </Button>
            <Popover className="border rounded shadow bg-body">
              <Menu aria-label="Choose a book to share" className="share-book-menu p-1">
                {shareBooks.map((book) => (
                  <MenuItem
                    key={book.txtId}
                    id={book.txtId}
                    className="dropdown-item rounded"
                    onAction={() => onShare(book.txtId)}
                  >
                    {book.title}
                  </MenuItem>
                ))}
              </Menu>
            </Popover>
          </MenuTrigger>
        )}
      </div>
    </div>
  );
}
