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

import { AccountFooter } from "../../components/AccountFooter";
import { BookmarkRow } from "../../components/BookmarkRow";
import { BookRow, BOOK_ROW_HEIGHT } from "../../components/BookRow";
import { DropdownToggleButton } from "../../components/DropdownToggleButton";
import { NavItem } from "../../components/NavItem";
import { VirtualizedListGroup } from "../../components/VirtualizedListGroup";
import { Wordmark } from "../../components/Wordmark";
import { useDropdown } from "../../hooks/useDropdown";
import { useVault } from "../../state/VaultContext";
import {
  allBooksSorted,
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

// BookmarkRow's rendered height (py-3 padding + its three-line title/
// part-line/preview) -- one line taller than BookRow, same text-truncate
// reasoning for why a fixed constant is safe here.
const BOOKMARK_ROW_HEIGHT = 100;
// The Authors/Subjects/Publishers browse-entry row's height -- a plain,
// single-line Bootstrap .list-group-item with no extra padding classes.
const BROWSE_ENTRY_ROW_HEIGHT = 44;

function LibraryNavContent({
  view,
  selectView,
  recentCount,
  allCount,
  authorEntries,
  subjectEntries,
  publisherEntries,
  displayName,
  isAdmin,
  onLock,
  onRefresh,
  refreshing,
}: {
  view: View;
  selectView: (next: View) => void;
  recentCount: number;
  allCount: number;
  authorEntries: BrowseEntry[];
  subjectEntries: BrowseEntry[];
  publisherEntries: BrowseEntry[];
  displayName: string | undefined;
  isAdmin: boolean;
  onLock: () => void;
  onRefresh: () => void;
  refreshing: boolean;
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

      {/* Who's signed in, and the (now icon-only) Refresh/Lock actions --
          moved here from the top bar so they're part of "your account"
          rather than sitting next to the search field. For an admin
          session, the name itself is a link to the Manage screen
          (RequireAdmin guards the route too, so this is purely "don't
          offer it" for a regular user, not the actual enforcement --
          that's Turso's own token grants). */}
      <AccountFooter
        displayName={displayName}
        manageLink={isAdmin}
        onRefresh={onRefresh}
        onLock={onLock}
        refreshing={refreshing}
        refreshAriaLabel="Refresh library"
      />
    </>
  );
}

export function LibraryScreen() {
  const { lock, refresh, refreshing, progress, session, bookmarksMap, removeAccessEntry, removeBookmarkEntry } =
    useVault();
  const navigate = useNavigate();
  const { books, loading } = useLibraryBooks();
  const [view, setView] = useState<View>({ kind: "recent" });
  const [search, setSearch] = useState("");
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Below the lg breakpoint the left nav collapses into the wordmark's
  // dropdown; picking anything in it closes it again so the chosen view
  // actually comes into view.
  const nav = useDropdown();

  function selectView(next: View) {
    setView(next);
    nav.close();
  }

  async function handleRefresh() {
    // Below lg, refreshing is triggered from inside this same dropdown --
    // close it right away (consistent with its toggle disabling for the
    // duration, and with selectView above closing it too) rather than
    // leaving it open over a drawer that's about to disappear/disable.
    nav.close();
    setRefreshError(null);
    try {
      await refresh();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    }
  }

  const authorEntries = useMemo(() => browseEntries(books ?? [], "author"), [books]);
  const subjectEntries = useMemo(() => browseEntries(books ?? [], "subject"), [books]);
  const publisherEntries = useMemo(() => browseEntries(books ?? [], "publisher"), [books]);
  const recent = useMemo(() => recentBooks(books ?? []), [books]);
  // Search only filters Continue Reading -- Recent Bookmarks isn't searchable.
  const continueReading = useMemo(
    () => (search.trim() ? recent.filter((b) => matchesSearch(b, search)) : recent),
    [recent, search],
  );
  const metadataById = useMemo(() => new Map((books ?? []).map((b) => [b.txtId, b.info])), [books]);
  const recentBookmarkItems = useMemo(() => recentBookmarks(bookmarksMap, metadataById), [bookmarksMap, metadataById]);

  // The "all"/"browseValue" views' book list, sorted (and for browseValue,
  // dimension-filtered) -- memoized separately from the search-query
  // filter below, so typing in the search box only re-runs a cheap linear
  // scan over this already-sorted list rather than re-sorting the entire
  // library on every keystroke.
  const baseBookList = useMemo<LibraryBook[] | null>(() => {
    if (view.kind === "all") return allBooksSorted(books ?? []);
    if (view.kind === "browseValue") return booksForDimensionValue(books ?? [], view.dimension, view.value);
    return null;
  }, [books, view]);

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
    // Every entry here has lastPartNum set (recentBooks() only includes
    // books with a lastAccessedMs, and the two are always set together --
    // see libraryModel.ts's buildLibraryBooks), so this is just its count.
    headingDetail = `${recent.length} in progress`;
  } else if (view.kind === "all") {
    const all = baseBookList ?? [];
    heading = "All books";
    headingDetail = `${all.length} book${all.length === 1 ? "" : "s"}`;
    bookList = all;
  } else if (view.kind === "browse") {
    const entries = { author: authorEntries, subject: subjectEntries, publisher: publisherEntries }[view.dimension];
    heading = DIMENSION_LABEL[view.dimension];
    headingDetail = `${entries.length}`;
    browseList = entries;
  } else {
    const filtered = baseBookList ?? [];
    heading = view.value;
    headingDetail = `${filtered.length} book${filtered.length === 1 ? "" : "s"}`;
    bookList = filtered;
  }

  if (bookList && search.trim()) {
    bookList = bookList.filter((b) => matchesSearch(b, search));
    // Recompute now that a search query may have shrunk bookList -- keeps
    // the header's count in sync with what's actually rendered below,
    // instead of showing the pre-search total.
    headingDetail = `${bookList.length} book${bookList.length === 1 ? "" : "s"}`;
  }

  return (
    <div className="shell-60 d-flex flex-column vh-100">
      {/* flex-nowrap, not flex-wrap: flexbox decides line breaks from each
          item's *hypothetical* (unshrunk) main size, not its post-shrink
          size -- so even with minWidth:0 below letting the content cell
          shrink, a wrapping container could still push it to a second line
          at viewport widths where its natural (un-shrunk) size doesn't fit
          next to the drawer toggle, before shrinking ever gets a chance to
          apply. Forcing one line makes that shrinking actually take effect,
          keeping the toggle and search box together at every width instead
          of wrapping at some in-between range. */}
      <div className="border-bottom d-flex flex-nowrap align-items-stretch">
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
            as tappable; the wordmark text sits beside it, plain, but is
            dropped below sm entirely -- on a phone-width screen there isn't
            room for the icon, "Skypiea", and the search box on one line, and
            the icon (still labeled via aria-label) plus search box matter
            more than the wordmark text there. There's no fixed-width
            alignment cell here -- below lg there's no persistent sidebar for
            it to line up against. */}
        <div
          ref={nav.ref}
          className="dropdown position-relative d-lg-none d-flex align-items-center gap-2 ps-2 ps-sm-3 py-2"
        >
          <DropdownToggleButton
            open={nav.open}
            onClick={nav.toggle}
            icon="bi-book"
            ariaLabel="Library menu"
            className="d-flex align-items-center justify-content-center"
            disabled={refreshing}
          />
          <span className="fw-semibold d-none d-sm-inline">Skypiea</span>
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
                isAdmin={session?.isAdmin ?? false}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={refreshing}
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
              className="form-control form-control-sm themed-control ps-5"
              placeholder="Search library"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={refreshing}
              aria-label="Search library"
            />
          </div>
        </div>
      </div>

      {refreshError && (
        <div className="alert alert-danger m-2 py-2 px-3 mb-0" role="alert">
          {refreshError}
        </div>
      )}

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
        {/* Refreshing replaces this entire region -- the lg+ sidebar
            (everything below the "Skypiea" wordmark: nav items, account
            footer, Lock/Refresh included) and the content pane alike --
            with one centered spinner. Only the top bar (wordmark/toggle,
            already-disabled search box) stays as it was; the below-lg
            dropdown copy of the nav is untouched too, since it isn't part
            of this persistent lg+ region at all. */}
        {refreshing ? (
          // role="status" on this wrapper, not the spinner glyph itself --
          // it's a live region, so the two text lines below get
          // re-announced as progress updates them (mirrors Unlock's own
          // spinner). A non-breaking space holds the first line's height
          // even before the first phase lands.
          <div className="flex-grow-1 d-flex flex-column align-items-center justify-content-center gap-1" role="status">
            <div className="spinner-border text-primary mb-1" aria-hidden="true" />
            <div className="small text-body-secondary">
              {progress ? `Step ${progress.step} of ${progress.total}` : " "}
            </div>
            <div className="small text-body-secondary">{progress?.label ?? "Refreshing your library"}…</div>
          </div>
        ) : (
          <>
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
                isAdmin={session?.isAdmin ?? false}
                onLock={lock}
                onRefresh={() => void handleRefresh()}
                refreshing={refreshing}
              />
            </div>

            <div className="flex-grow-1 d-flex flex-column overflow-hidden" style={{ minWidth: 0 }}>
              <div className="d-flex justify-content-between align-items-baseline px-3 py-2 border-bottom">
                <h2 className="h6 mb-0">{heading}</h2>
                <span className="small text-body-secondary">{headingDetail}</span>
              </div>

              {/* d-flex flex-column, not overflow-auto itself -- each branch
                  below owns its own bounded, independently-scrolling region
                  instead of sharing one ambient page scroll, since
                  VirtualizedListGroup needs a concrete viewport to compute
                  which rows are visible. Recent's two sections size to
                  their own content (no flex-grow) capped at maxHeight:50%
                  each, rather than always splitting the available height
                  evenly -- a short Continue Reading no longer leaves a gap
                  above Recent Bookmarks the way an equal, content-agnostic
                  split would. */}
              <div className="flex-grow-1 d-flex flex-column overflow-hidden">
                {loading && <p className="text-body-secondary p-3">Loading your library…</p>}

                {!loading && view.kind === "recent" && (
                  <>
                    <div className="small text-body-secondary text-uppercase fw-semibold px-3 pt-3 pb-1">
                      Continue Reading
                    </div>
                    <VirtualizedListGroup
                      style={{ maxHeight: "50%" }}
                      items={continueReading}
                      getKey={(book) => book.txtId}
                      estimateRowHeight={BOOK_ROW_HEIGHT}
                      emptyMessage="No books in progress yet."
                      renderRow={(book) => (
                        <BookRow
                          book={book}
                          onClick={() => openBook(book)}
                          onDelete={() => void removeAccessEntry(book.txtId)}
                          hidePartNum
                        />
                      )}
                    />

                    <div className="small text-body-secondary text-uppercase fw-semibold px-3 pt-4 pb-1">
                      Recent Bookmarks
                    </div>
                    <VirtualizedListGroup
                      style={{ maxHeight: "50%" }}
                      items={recentBookmarkItems}
                      getKey={(item) => `${item.txtId}-${item.createdAt}`}
                      estimateRowHeight={BOOKMARK_ROW_HEIGHT}
                      emptyMessage="No bookmarks yet."
                      renderRow={(item) => (
                        <BookmarkRow
                          title={item.info.title}
                          partNum={item.partNum}
                          line={item.line}
                          txtPreview={item.txtPreview}
                          onClick={() => openBookmark(item)}
                          onDelete={() => void removeBookmarkEntry(item.txtId, item.createdAt)}
                          deleteAriaLabel={`Remove this bookmark in ${item.info.title}`}
                        />
                      )}
                    />
                  </>
                )}

                {!loading && view.kind !== "recent" && browseList && (
                  <VirtualizedListGroup
                    className="flex-grow-1"
                    items={browseList}
                    getKey={(entry) => entry.value}
                    estimateRowHeight={BROWSE_ENTRY_ROW_HEIGHT}
                    emptyMessage="Nothing here yet."
                    renderRow={(entry) => (
                      <button
                        type="button"
                        className="list-group-item list-group-item-action d-flex justify-content-between align-items-center w-100"
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
                    )}
                  />
                )}

                {!loading && view.kind !== "recent" && bookList && (
                  <VirtualizedListGroup
                    className="flex-grow-1"
                    items={bookList}
                    getKey={(book) => book.txtId}
                    estimateRowHeight={BOOK_ROW_HEIGHT}
                    emptyMessage="No books match here yet."
                    renderRow={(book) => <BookRow book={book} onClick={() => openBook(book)} />}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
