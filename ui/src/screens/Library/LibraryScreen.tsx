// Screen 2 -- Library (docs/ui.md): a catalog nav on the left, a plain list
// of books on the right. Top bar stays a slim strip above both panes:
// wordmark and a search field. Account status/actions (who's signed in, and
// locking the vault) live in the nav's account footer instead, not the top
// bar.
//
// Below lg, the nav has no room to sit beside the book list, so its content
// (NavItem lists) is shared between two renderings instead of duplicated:
// a persistent lg+ sidebar, and a dropdown below lg -- toggled by the book
// icon alone (not the full wordmark) rather than a separate hamburger
// button next to it.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { BookmarkRow } from "../../components/BookmarkRow";
import { BookRow } from "../../components/BookRow";
import { Wordmark } from "../../components/Wordmark";
import { useDropdown } from "../../hooks/useDropdown";
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
  displayName,
  onLock,
}: {
  view: View;
  selectView: (next: View) => void;
  recentCount: number;
  allCount: number;
  authorEntries: BrowseEntry[];
  subjectEntries: BrowseEntry[];
  publisherEntries: BrowseEntry[];
  displayName: string | undefined;
  onLock: () => void;
}) {
  return (
    <>
      <div className="flex-grow-1 overflow-auto">
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
      </div>

      {/* The account footer: who's signed in, and the (now icon-only) Lock
          action -- moved here from the top bar so it's part of "your
          account" rather than sitting next to the search field. */}
      <div className="border-top pt-2 mt-2 d-flex align-items-center justify-content-between gap-2">
        <span className="d-flex align-items-center gap-2 text-truncate">
          <i className="bi bi-person-circle text-body-secondary flex-shrink-0" aria-hidden="true" />
          <span className="small text-body-secondary text-truncate">{displayName}</span>
        </span>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary border-primary flex-shrink-0"
          onClick={onLock}
          aria-label="Lock"
          title="Lock"
        >
          <i className="bi bi-unlock text-primary" aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

export function LibraryScreen() {
  const { lock, session, bookmarksMap, removeAccessEntry, removeBookmarkEntry } = useVault();
  const navigate = useNavigate();
  const { books, loading } = useLibraryBooks();
  const [view, setView] = useState<View>({ kind: "recent" });
  const [search, setSearch] = useState("");
  // Below the lg breakpoint the left nav collapses into the wordmark's
  // dropdown; picking anything in it closes it again so the chosen view
  // actually comes into view.
  const nav = useDropdown();

  function selectView(next: View) {
    setView(next);
    nav.close();
  }

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
    <div className="shell-60 d-flex flex-column vh-100">
      <div className="border-bottom d-flex flex-wrap align-items-stretch">
        {/* lg+: a fixed-width cell -- same class (and width) as the sidebar
            below -- so the content cell beside it starts at the same x as
            the right pane's own content, and its border-end continues the
            sidebar's vertical rule upward into the top bar. .library-nav
            sets flex-direction:column (for the sidebar's own content-above-
            footer stacking), which flips align-items-center to a
            *horizontal* centering here -- justify-content-center is what
            actually centers the wordmark vertically in a column-direction
            flex container, since its main axis is now the vertical one. */}
        <div className="library-nav border-end p-2 d-none d-lg-flex align-items-center justify-content-center">
          <Wordmark />
        </div>

        {/* Below lg: the book icon alone (not the "Skypiea" text) is the
            drawer toggle -- styled as a visible bordered button so it reads
            as tappable; the wordmark text sits beside it, plain. There's no
            fixed-width alignment cell here -- below lg there's no
            persistent sidebar for it to line up against. */}
        <div
          ref={nav.ref}
          className="dropdown position-relative d-lg-none d-flex align-items-center gap-2 ps-2 ps-sm-3 py-2"
        >
          <button
            type="button"
            className={`btn btn-sm d-flex align-items-center justify-content-center ${nav.open ? "btn-primary" : "btn-outline-secondary border-primary"}`}
            onClick={nav.toggle}
            aria-expanded={nav.open}
            aria-haspopup="true"
            aria-label="Library menu"
          >
            <i className={`bi bi-book ${nav.open ? "" : "text-primary"}`} aria-hidden="true" />
          </button>
          <span className="fw-semibold">Skypiea</span>
          {nav.open && (
            <div
              className="dropdown-menu app-dropdown-menu app-dropdown-menu-start show p-2 d-flex flex-column"
              style={{ width: "16rem", maxWidth: "90vw", maxHeight: "70vh" }}
            >
              <LibraryNavContent
                view={view}
                selectView={selectView}
                recentCount={recent.length}
                allCount={(books ?? []).length}
                authorEntries={authorEntries}
                subjectEntries={subjectEntries}
                publisherEntries={publisherEntries}
                displayName={session?.creds.displayName}
                onLock={lock}
              />
            </div>
          )}
        </div>

        {/* Content cell: same horizontal padding (px-3) as the right pane's
            own header row below, so the search bar's left edge lines up
            with the book list's heading/rows -- and at lg+ the input
            itself is capped to half this cell's width instead of
            stretching across the whole pane. */}
        <div className="flex-grow-1 d-flex align-items-center px-3 py-2" style={{ minWidth: 0 }}>
          <div className="position-relative search-bar-width">
            {/* The icon sits inside the input itself (absolutely
                positioned, padding-left on the input to make room) rather
                than Bootstrap's input-group, which renders it as its own
                bordered segment beside the input -- visually two joined
                boxes, not one. */}
            <i
              className="bi bi-search position-absolute top-50 start-0 translate-middle-y ms-3 text-body-secondary pe-none"
              aria-hidden="true"
            />
            <input
              type="search"
              className="form-control themed-control ps-5"
              placeholder="Search your library"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search your library"
            />
          </div>
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
        <div className="library-nav border-end p-2 d-none d-lg-flex">
          <LibraryNavContent
            view={view}
            selectView={selectView}
            recentCount={recent.length}
            allCount={(books ?? []).length}
            authorEntries={authorEntries}
            subjectEntries={subjectEntries}
            publisherEntries={publisherEntries}
            displayName={session?.creds.displayName}
            onLock={lock}
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
                      title={item.info.title}
                      partNum={item.partNum}
                      line={item.line}
                      txtPreview={item.txtPreview}
                      onClick={() => openBookmark(item)}
                      onDelete={() => void removeBookmarkEntry(item.txtId, item.createdAt)}
                      deleteAriaLabel={`Remove this bookmark in ${item.info.title}`}
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
