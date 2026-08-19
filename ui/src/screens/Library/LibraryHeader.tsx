import type { ReactNode } from "react";
import { Button, Input, SearchField } from "react-aria-components";
import type { LibraryBook } from "../../data/libraryDb";
import type { BookShare } from "../../data/shares";
import { classNames } from "../../util/classNames";

export function LibraryHeader({
  query,
  onQuery,
  menu,
  selectedBook,
  selectedShare,
  showBookActions,
  showShareActions,
  canShare,
  onRead,
  onShare,
  onCopyShare,
  onDeleteShare,
}: {
  query: string;
  onQuery: (query: string) => void;
  menu: ReactNode;
  selectedBook: LibraryBook | null;
  selectedShare: BookShare | null;
  showBookActions: boolean;
  showShareActions: boolean;
  canShare: boolean;
  onRead: () => void;
  onShare: () => void;
  onCopyShare: () => void;
  onDeleteShare: () => void;
}) {
  const showFullBrand = menu === null;
  return (
    <div className="d-flex align-items-center border-bottom flex-shrink-0">
      <div
        className={classNames(
          "d-flex align-items-center gap-2 px-2 py-2 library-brand-col",
          showFullBrand && "px-md-3 library-pane-col",
        )}
      >
        {menu}
        {showFullBrand && (
          <div className="d-flex align-items-center gap-2">
            <i className="bi bi-book fs-5" aria-hidden="true" />
            <span className="fw-semibold fs-5">Skypiea</span>
          </div>
        )}
      </div>
      <div className="d-flex flex-grow-1 px-2 px-md-3 py-2 min-w-0 library-search-col">
        <div
          className={classNames(
            "library-search-group d-flex min-w-0",
            !showFullBrand && "library-search-group-single-pane",
          )}
        >
          <SearchField
            className="search-box position-relative min-w-0"
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
          {showBookActions && (
            <div className="btn-group library-book-actions" aria-label="Book actions">
              <BookAction
                label="Read"
                icon="book-half"
                isDisabled={!selectedBook}
                onPress={onRead}
              />
              {canShare && (
                <BookAction
                  label="Share"
                  icon="share"
                  isDisabled={!selectedBook}
                  onPress={onShare}
                />
              )}
            </div>
          )}
          {showShareActions && (
            <div className="btn-group library-book-actions" aria-label="Share actions">
              <BookAction
                label="Copy"
                icon="copy"
                isDisabled={!selectedShare || selectedShare.state !== "active"}
                onPress={onCopyShare}
              />
              <BookAction
                label="Delete this share"
                visibleLabel="Delete"
                icon="trash"
                isDisabled={!selectedShare}
                onPress={onDeleteShare}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BookAction({
  label,
  visibleLabel = label,
  icon,
  isDisabled,
  onPress,
}: {
  label: string;
  visibleLabel?: string;
  icon: string;
  isDisabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      className="btn btn-sm btn-outline-secondary flex-shrink-0"
      aria-label={label}
      isDisabled={isDisabled}
      onPress={onPress}
    >
      <i className={`bi bi-${icon} me-md-1`} aria-hidden="true" />
      <span className="d-none d-md-inline">{visibleLabel}</span>
    </Button>
  );
}
