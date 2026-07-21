// Screen 2 -- Library (docs/ui.md): a catalog nav on the left, a plain list
// of books on the right. Top bar stays a slim strip above both panes:
// wordmark, a search field, and a status pill confirming the vault is
// unlocked.
//
// Below lg, the nav has no room to sit beside the book list, so its content
// (NavItem lists) is shared between two renderings instead of duplicated:
// a persistent lg+ sidebar, and a dropdown below lg -- merged into the
// wordmark itself (clicking it is what opens/closes the dropdown, rather
// than a separate hamburger button next to it).

import { useEffect, useMemo, useRef, useState } from "react";
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
  type BrowseEntry,
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

function NavItem({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
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

function LibraryNavContent({
  view,
  selectView,
  recentCount,
  allCount,
  authorEntries,
  subjectEntries,
  publisherEntries,
}: {
  view: View;
  selectView: (next: View) => void;
  recentCount: number;
  allCount: number;
  authorEntries: BrowseEntry[];
  subjectEntries: BrowseEntry[];
  publisherEntries: BrowseEntry[];
}) {
  return (
    <>
      <div className="list-group list-group-flush">
        <NavItem
          active={view.kind === "recent"}
          label="Recent"
          count={recentCount}
          onClick={() => selectView({ kind: "recent" })}
        />
        <NavItem
          active={view.kind === "all"}
          label="All books"
          count={allCount}
          onClick={() => selectView({ kind: "all" })}
        />
      </div>
      <div className="text-body-secondary small fw-semibold text-uppercase mt-3 mb-1 px-2">Browse</div>
      <div className="list-group list-group-flush">
        <NavItem
          active={view.kind === "browse" && view.dimension === "author"}
          label="Authors"
          count={authorEntries.length}
          onClick={() => selectView({ kind: "browse", dimension: "author" })}
        />
        <NavItem
          active={view.kind === "browse" && view.dimension === "subject"}
          label="Subjects"
          count={subjectEntries.length}
          onClick={() => selectView({ kind: "browse", dimension: "subject" })}
        />
        <NavItem
          active={view.kind === "browse" && view.dimension === "publisher"}
          label="Publishers"
          count={publisherEntries.length}
          onClick={() => selectView({ kind: "browse", dimension: "publisher" })}
        />
      </div>
    </>
  );
}

export function LibraryScreen() {
  const { lock, bookmarksMap, removeAccessEntry, removeBookmarkEntry } = useVault();
  const navigate = useNavigate();
  const { books, loading } = useLibraryBooks();
  const [view, setView] = useState<View>({ kind: "recent" });
  const [search, setSearch] = useState("");
  // Below the lg breakpoint the left nav collapses into the wordmark's
  // dropdown; picking anything in it closes it again so the chosen view
  // actually comes into view.
  const [navOpen, setNavOpen] = useState(false);
  const navMenuRef = useRef<HTMLDivElement>(null);

  function selectView(next: View) {
    setView(next);
    setNavOpen(false);
  }

  // Closing on an outside click/Escape is what makes this read as a
  // dropdown rather than a plain toggle panel -- there's no Bootstrap JS in
  // this project (only its CSS), so this is hand-rolled instead of relying
  // on its dropdown plugin (same pattern as the Reader screen's dropdowns).
  useEffect(() => {
    if (!navOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (navMenuRef.current && !navMenuRef.current.contains(event.target as Node)) {
        setNavOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setNavOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [navOpen]);

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
    <div className="shell-80 d-flex flex-column vh-100">
      <div className="border-bottom d-flex flex-wrap align-items-center gap-2 gap-md-3 ps-2 ps-sm-3 pe-3 py-2">
        {/* Below lg: the wordmark itself is the drawer toggle -- merged
            instead of a separate hamburger button next to it. */}
        <div ref={navMenuRef} className="dropdown position-relative d-lg-none">
          <button
            type="button"
            className="btn btn-link text-decoration-none p-0 border-0"
            onClick={() => setNavOpen((open) => !open)}
            aria-expanded={navOpen}
            aria-haspopup="true"
            aria-label="Library menu"
          >
            <Wordmark />
          </button>
          {navOpen && (
            <div
              className="dropdown-menu app-dropdown-menu show p-2"
              style={{ width: "16rem", maxWidth: "90vw", maxHeight: "70vh", overflowY: "auto" }}
            >
              <LibraryNavContent
                view={view}
                selectView={selectView}
                recentCount={recent.length}
                allCount={(books ?? []).length}
                authorEntries={authorEntries}
                subjectEntries={subjectEntries}
                publisherEntries={publisherEntries}
              />
            </div>
          )}
        </div>
        {/* lg+: plain, non-interactive branding -- the sidebar's always
            visible there, so there's nothing for the wordmark to toggle. */}
        <div className="d-none d-lg-block">
          <Wordmark />
        </div>
        <div className="flex-grow-1" style={{ minWidth: "10rem", maxWidth: "28rem" }}>
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
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-pill d-flex align-items-center gap-2"
            onClick={lock}
          >
            <i className="bi bi-unlock" aria-hidden="true" />
            Lock
          </button>
        </div>
      </div>

      {/*
        The sidebar only ever renders at lg+ now -- below that, the same
        content shows inside the wordmark's dropdown instead (top bar,
        above). At lg+, flex items default to min-width:auto, meaning a
        child won't shrink below its own content's intrinsic width even with
        overflow-hidden/text-truncate on a descendant -- so a long title/
        author/subject list in the right pane could otherwise demand more
        width than available and squeeze this fixed-width nav out of the
        way. The right pane gets minWidth:0 below (let its own long content
        actually truncate instead of forcing extra width).
      */}
      <div className="flex-grow-1 d-flex flex-column flex-lg-row overflow-hidden">
        <div className="library-nav border-end p-2 d-none d-lg-block" style={{ overflowY: "auto" }}>
          <LibraryNavContent
            view={view}
            selectView={selectView}
            recentCount={recent.length}
            allCount={(books ?? []).length}
            authorEntries={authorEntries}
            subjectEntries={subjectEntries}
            publisherEntries={publisherEntries}
          />
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
                <div className="small text-body-secondary text-uppercase fw-semibold px-3 pt-3 pb-1">
                  Continue Reading
                </div>
                <div className="list-group list-group-flush">
                  {continueReading.map((book) => (
                    <BookRow
                      key={book.txtId}
                      book={book}
                      onClick={() => openBook(book)}
                      onDelete={() => void removeAccessEntry(book.txtId)}
                      hidePartNum
                    />
                  ))}
                  {continueReading.length === 0 && (
                    <p className="text-body-secondary px-3 pb-3">No books in progress yet.</p>
                  )}
                </div>

                <div className="small text-body-secondary text-uppercase fw-semibold px-3 pt-4 pb-1">
                  Recent Bookmarks
                </div>
                <div className="list-group list-group-flush">
                  {recentBookmarkItems.map((item) => (
                    <BookmarkRow
                      key={`${item.txtId}-${item.createdAt}`}
                      item={item}
                      onClick={() => openBookmark(item)}
                      onDelete={() => void removeBookmarkEntry(item.txtId, item.createdAt)}
                    />
                  ))}
                  {recentBookmarkItems.length === 0 && (
                    <p className="text-body-secondary px-3 pb-3">No bookmarks yet.</p>
                  )}
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
                      selectView({
                        kind: "browseValue",
                        dimension: (view as { dimension: BrowseDimension }).dimension,
                        value: entry.value,
                      })
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
