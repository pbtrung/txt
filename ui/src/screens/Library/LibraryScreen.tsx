// Screen 2 -- Library (docs/ui.md): a catalog nav on the left, a plain list
// of books on the right. Top bar stays a slim strip above both panes:
// wordmark, a search field, and a status pill confirming the vault is
// unlocked.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { BookmarkRow } from "../../components/BookmarkRow";
import { BookRow } from "../../components/BookRow";
import { StatusPill } from "../../components/StatusPill";
import { Wordmark } from "../../components/Wordmark";
import { useVault } from "../../state/VaultContext";
import {
  allBooksSorted,
  bookStatus,
  browseEntries,
  booksForDimensionValue,
  matchesSearch,
  recentBookmarks,
  recentBooks,
  type BrowseDimension,
  type LibraryBook,
  type RecentBookmarkItem,
} from "./libraryModel";
import { useLibraryBooks } from "./useLibraryBooks";

type View =
  | { kind: "recent" }
  | { kind: "all" }
  | { kind: "browse"; dimension: BrowseDimension }
  | { kind: "browseValue"; dimension: BrowseDimension; value: string };

const DIMENSION_LABEL: Record<BrowseDimension, string> = {
  author: "Authors",
  subject: "Subjects",
  publisher: "Publishers",
};

function NavItem({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <span className="text-truncate">{label}</span>
      <span className={`flex-shrink-0 ${active ? "" : "text-body-secondary"}`}>{count}</span>
    </button>
  );
}

export function LibraryScreen() {
  const { lock, bookmarksMap, removeAccessEntry, removeBookmarkEntry } = useVault();
  const navigate = useNavigate();
  const { books, loading } = useLibraryBooks();
  const [view, setView] = useState<View>({ kind: "recent" });
  const [search, setSearch] = useState("");

  const authorEntries = useMemo(() => browseEntries(books ?? [], "author"), [books]);
  const subjectEntries = useMemo(() => browseEntries(books ?? [], "subject"), [books]);
  const publisherEntries = useMemo(() => browseEntries(books ?? [], "publisher"), [books]);
  const recent = useMemo(() => recentBooks(books ?? []), [books]);
  const inProgressCount = useMemo(() => recent.filter((b) => bookStatus(b) === "in-progress").length, [recent]);
  // Search only filters Continue Reading -- Recent Bookmarks isn't searchable.
  const continueReading = useMemo(
    () => (search.trim() ? recent.filter((b) => matchesSearch(b, search)) : recent),
    [recent, search],
  );
  const metadataById = useMemo(() => new Map((books ?? []).map((b) => [b.txtId, b.info])), [books]);
  const recentBookmarkItems = useMemo(() => recentBookmarks(bookmarksMap, metadataById), [bookmarksMap, metadataById]);

  function openBook(book: LibraryBook) {
    navigate(`/read/${book.txtId}`);
  }

  function openBookmark(item: RecentBookmarkItem) {
    navigate(`/read/${item.txtId}?part=${item.partNum}&line=${item.line}`);
  }

  let heading: string;
  let headingDetail: string;
  let bookList: LibraryBook[] | null = null;
  let browseList: { value: string; count: number }[] | null = null;

  if (view.kind === "recent") {
    heading = "Recent";
    headingDetail = `${inProgressCount} in progress`;
  } else if (view.kind === "all") {
    const all = allBooksSorted(books ?? []);
    heading = "All books";
    headingDetail = `${all.length} book${all.length === 1 ? "" : "s"}`;
    bookList = all;
  } else if (view.kind === "browse") {
    const entries = { author: authorEntries, subject: subjectEntries, publisher: publisherEntries }[view.dimension];
    heading = DIMENSION_LABEL[view.dimension];
    headingDetail = `${entries.length}`;
    browseList = entries;
  } else {
    const filtered = booksForDimensionValue(books ?? [], view.dimension, view.value);
    heading = view.value;
    headingDetail = `${filtered.length} book${filtered.length === 1 ? "" : "s"}`;
    bookList = filtered;
  }

  if (bookList && search.trim()) {
    bookList = bookList.filter((b) => matchesSearch(b, search));
  }

  return (
    <div className="d-flex flex-column vh-100">
      <div className="border-bottom d-flex align-items-center gap-3 px-3 py-2">
        <Wordmark />
        <div className="flex-grow-1" style={{ maxWidth: "28rem" }}>
          <div className="input-group">
            <span className="input-group-text bg-transparent">
              <i className="bi bi-search" aria-hidden="true" />
            </span>
            <input
              type="search"
              className="form-control"
              placeholder="Search your library"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search your library"
            />
          </div>
        </div>
        <div className="ms-auto d-flex align-items-center gap-3">
          <StatusPill>Unlocked</StatusPill>
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={lock}>
            Lock
          </button>
        </div>
      </div>

      {/*
        Flex items default to min-width:auto, meaning a child won't shrink
        below its own content's intrinsic width even with overflow-hidden/
        text-truncate on a descendant -- so a long title/author/subject
        list in the right pane could otherwise demand more width than
        available and squeeze this fixed-width nav out of the way. The
        nav gets flexShrink:0 (never give up its width) and the right pane
        gets minWidth:0 below (let its own long content actually truncate
        instead of forcing extra width).
      */}
      <div className="flex-grow-1 d-flex overflow-hidden">
        <div className="border-end p-2" style={{ width: "16rem", flexShrink: 0, overflowY: "auto" }}>
          <div className="list-group list-group-flush">
            <NavItem active={view.kind === "recent"} label="Recent" count={recent.length} onClick={() => setView({ kind: "recent" })} />
            <NavItem active={view.kind === "all"} label="All books" count={(books ?? []).length} onClick={() => setView({ kind: "all" })} />
          </div>
          <div className="text-body-secondary small fw-semibold text-uppercase mt-3 mb-1 px-2">Browse</div>
          <div className="list-group list-group-flush">
            <NavItem
              active={view.kind === "browse" && view.dimension === "author"}
              label="Authors"
              count={authorEntries.length}
              onClick={() => setView({ kind: "browse", dimension: "author" })}
            />
            <NavItem
              active={view.kind === "browse" && view.dimension === "subject"}
              label="Subjects"
              count={subjectEntries.length}
              onClick={() => setView({ kind: "browse", dimension: "subject" })}
            />
            <NavItem
              active={view.kind === "browse" && view.dimension === "publisher"}
              label="Publishers"
              count={publisherEntries.length}
              onClick={() => setView({ kind: "browse", dimension: "publisher" })}
            />
          </div>
        </div>

        <div className="flex-grow-1 d-flex flex-column overflow-hidden" style={{ minWidth: 0 }}>
          <div className="d-flex justify-content-between align-items-baseline px-3 py-2 border-bottom">
            <h2 className="h6 mb-0">{heading}</h2>
            <span className="small text-body-secondary">{headingDetail}</span>
          </div>

          <div className="flex-grow-1 overflow-auto">
            {loading && <p className="text-body-secondary p-3">Loading your library…</p>}

            {!loading && view.kind === "recent" && (
              <>
                <div className="small text-body-secondary text-uppercase fw-semibold px-3 pt-3 pb-1">Continue Reading</div>
                <div className="list-group list-group-flush">
                  {continueReading.map((book) => (
                    <BookRow
                      key={book.txtId}
                      book={book}
                      onClick={() => openBook(book)}
                      onDelete={() => void removeAccessEntry(book.txtId)}
                    />
                  ))}
                  {continueReading.length === 0 && <p className="text-body-secondary px-3 pb-3">No books in progress yet.</p>}
                </div>

                <div className="small text-body-secondary text-uppercase fw-semibold px-3 pt-4 pb-1">Recent Bookmarks</div>
                <div className="list-group list-group-flush">
                  {recentBookmarkItems.map((item) => (
                    <BookmarkRow
                      key={`${item.txtId}-${item.createdAt}`}
                      item={item}
                      onClick={() => openBookmark(item)}
                      onDelete={() => void removeBookmarkEntry(item.txtId, item.createdAt)}
                    />
                  ))}
                  {recentBookmarkItems.length === 0 && <p className="text-body-secondary px-3 pb-3">No bookmarks yet.</p>}
                </div>
              </>
            )}

            {!loading && view.kind !== "recent" && browseList && (
              <div className="list-group list-group-flush">
                {browseList.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    className="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                    onClick={() =>
                      setView({ kind: "browseValue", dimension: (view as { dimension: BrowseDimension }).dimension, value: entry.value })
                    }
                  >
                    <span className="text-truncate" style={{ minWidth: 0 }}>
                      {entry.value}
                    </span>
                    <span className="text-body-secondary flex-shrink-0 ms-2">{entry.count}</span>
                  </button>
                ))}
                {browseList.length === 0 && <p className="text-body-secondary p-3">Nothing here yet.</p>}
              </div>
            )}

            {!loading && view.kind !== "recent" && bookList && (
              <div className="list-group list-group-flush">
                {bookList.map((book) => (
                  <BookRow key={book.txtId} book={book} onClick={() => openBook(book)} />
                ))}
                {bookList.length === 0 && <p className="text-body-secondary p-3">No books match here yet.</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
