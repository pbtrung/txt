import type { ReactNode } from "react";
import {
  BookOpen,
  Copy,
  Search,
  Share2,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
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
    <div className="flex shrink-0 items-center border-b border-base-300">
      <div
        className={classNames(
          "flex items-center gap-2 px-2 py-2 library-brand-col",
          showFullBrand && "md:px-3 library-pane-col",
        )}
      >
        {menu}
        {showFullBrand && (
          <div className="flex items-center gap-2">
            <BookOpen className="size-5" aria-hidden="true" />
            <span className="text-xl font-semibold">Skypiea</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 px-2 py-2 md:px-3 library-search-col">
        <div
          className={classNames(
            "library-search-group join flex min-w-0",
            !showFullBrand && "library-search-group-single-pane",
          )}
        >
          <SearchField
            className="search-box join-item relative min-w-0"
            aria-label="Search"
            value={query}
            onChange={onQuery}
          >
            <Search className="search-box-icon" aria-hidden="true" />
            <Input className="search-box-input" placeholder="Search…" />
            <Button className="search-box-clear" aria-label="Clear search">
              <X className="search-box-clear-icon" aria-hidden="true" />
            </Button>
          </SearchField>
          {showBookActions && (
            <div className="join library-book-actions" aria-label="Book actions">
              <BookAction
                label="Read"
                icon={BookOpen}
                isDisabled={!selectedBook}
                onPress={onRead}
              />
              {canShare && (
                <BookAction
                  label="Share"
                  icon={Share2}
                  isDisabled={!selectedBook}
                  onPress={onShare}
                />
              )}
            </div>
          )}
          {showShareActions && (
            <div className="join library-book-actions" aria-label="Share actions">
              <BookAction
                label="Copy"
                icon={Copy}
                isDisabled={!selectedShare || selectedShare.state !== "active"}
                onPress={onCopyShare}
              />
              <BookAction
                label="Delete this share"
                visibleLabel="Delete"
                icon={Trash2}
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
  icon: LucideIcon;
  isDisabled: boolean;
  onPress: () => void;
}) {
  const Icon = icon;
  return (
    <Button
      className="btn btn-sm btn-square btn-outline btn-secondary join-item shrink-0 md:w-auto md:px-3"
      aria-label={label}
      isDisabled={isDisabled}
      onPress={onPress}
    >
      <Icon className="size-4 md:mr-1" aria-hidden="true" />
      <span className="hidden md:inline">{visibleLabel}</span>
    </Button>
  );
}
