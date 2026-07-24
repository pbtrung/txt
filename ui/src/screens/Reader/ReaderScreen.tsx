// Screen 3 -- Reader (docs/ui.md): a reading pane with a part-navigation bar
// along the bottom. "About this book" is a dropdown off the top bar;
// "Bookmarks" is a dropdown off the bottom bar (opening upward, since it's
// anchored near the bottom of the screen) -- both closed by default, no
// persistent side panel, the reading pane is always full width.
//
// Bookmarking is per-line (docs/data_model.md's bookmarks: {part_num, line,
// txt_preview}), not per-part: each line in the reading pane has its own
// gutter bookmark button, so "bookmark by line number" is just "click the
// line's own icon" -- no separate number-entry control needed.

import { useEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

// Literata: a serif typeface designed for long-form reading (Google Fonts'
// dedicated ebook font), self-hosted via @fontsource rather than fetched
// from a remote origin -- consistent with this app's other assets
// (leancrypto/brotli wasm, bootstrap-icons' font) and required by index.html's
// CSP, which only allows font-src 'self'. Only the two weights the reading
// pane actually renders (400 for line text, 500 for the title heading, which
// inherits Bootstrap's default heading weight) are imported.
import "@fontsource/literata/400.css";
import "@fontsource/literata/500.css";

import { BookmarkRow } from "../../components/BookmarkRow";
import { DropdownToggleButton } from "../../components/DropdownToggleButton";
import { useDropdown } from "../../hooks/useDropdown";
import { splitLines, truncatePreview } from "./readerModel";
import { descriptionPlainText, sanitizeDescriptionHtml } from "./sanitizeHtml";
import { useReaderBook } from "./useReaderBook";

function lineElementId(lineNum: number): string {
  return `reader-line-${lineNum}`;
}

const DESCRIPTION_PREVIEW_LEN = 200;

// The reading pane's body-text size -- a plain per-session preference (not
// persisted, not part of the vault), so a fresh visit always starts at a
// default rather than carrying over a size chosen for a different book.
// That default itself depends on viewport size, checked once at mount (not
// tracked live -- resizing afterward shouldn't fight a size the user may
// have since picked themselves): a phone-sized screen defaults smaller,
// matching the same sm breakpoint this screen already uses elsewhere
// (bottomBarHidden's d-sm-flex) to distinguish a phone from anything
// bigger.
const FONT_SIZES_PX = [14, 16, 18, 20, 22, 24];
const SMALL_SCREEN_DEFAULT_FONT_SIZE_PX = 16;
const FULL_SCREEN_DEFAULT_FONT_SIZE_PX = 18;
const SMALL_SCREEN_MEDIA_QUERY = "(max-width: 575.98px)";

function defaultFontSizePx(): number {
  return window.matchMedia(SMALL_SCREEN_MEDIA_QUERY).matches
    ? SMALL_SCREEN_DEFAULT_FONT_SIZE_PX
    : FULL_SCREEN_DEFAULT_FONT_SIZE_PX;
}

export function ReaderScreen() {
  const { txtId } = useParams();
  const navigate = useNavigate();
  const numericTxtId = Number(txtId);
  const infoMenu = useDropdown();
  const bookmarksMenu = useDropdown();
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [fontSizePx, setFontSizePx] = useState(defaultFontSizePx);

  // Below sm, the bottom bar auto-hides on scroll-down (more room for text
  // on a phone) and reappears on scroll-up or once back at the top -- at sm+
  // it stays put regardless (see the bar's own d-sm-flex below, which
  // overrides d-none there no matter what this state is). While hidden, a
  // floating scroll-to-top button takes its place as the way back up/to the
  // bar's controls (Bookmarks, in particular, would otherwise be
  // unreachable without manually scrolling back).
  const [bottomBarHidden, setBottomBarHidden] = useState(false);
  const lastScrollTopRef = useRef(0);
  const readingPaneRef = useRef<HTMLDivElement>(null);

  const {
    loading,
    error,
    info,
    partCount,
    currentPartNum,
    partText,
    partTextLoading,
    bookmarks,
    targetLine,
    clearTargetLine,
    goToPart,
    goToBookmark,
    next,
    previous,
    bookmarkLine,
    removeBookmark,
  } = useReaderBook(numericTxtId);

  // The bottom bar's editable part-number box: a local, freely-typeable
  // string kept in sync with currentPartNum whenever *that* changes (paging,
  // a bookmark jump, ...), but not on every keystroke -- otherwise typing
  // would be overwritten mid-edit.
  const [partInput, setPartInput] = useState(() => String(currentPartNum));
  useEffect(() => setPartInput(String(currentPartNum)), [currentPartNum]);

  function commitPartInput() {
    const parsed = Number(partInput);
    if (Number.isInteger(parsed) && parsed > 0) {
      goToPart(parsed); // clamps to [1, partCount] itself
    } else {
      setPartInput(String(currentPartNum));
    }
  }

  // A fresh book starts with its description collapsed again.
  useEffect(() => setDescriptionExpanded(false), [numericTxtId]);

  // A fresh book or part lands at the top of the reading pane (a new
  // scrollable element, scrollTop 0) -- so the bar shouldn't stay hidden
  // from wherever the *previous* one had scrolled to.
  useEffect(() => setBottomBarHidden(false), [numericTxtId, currentPartNum]);

  const SCROLL_HIDE_THRESHOLD_PX = 10;
  function handleReadingPaneScroll(event: UIEvent<HTMLDivElement>) {
    const scrollTop = event.currentTarget.scrollTop;
    const delta = scrollTop - lastScrollTopRef.current;
    if (scrollTop <= 0) {
      setBottomBarHidden(false);
    } else if (delta > SCROLL_HIDE_THRESHOLD_PX) {
      setBottomBarHidden(true);
    } else if (delta < -SCROLL_HIDE_THRESHOLD_PX) {
      setBottomBarHidden(false);
    }
    lastScrollTopRef.current = scrollTop;
  }

  function scrollToTop() {
    readingPaneRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setBottomBarHidden(false);
  }

  const lines = useMemo(() => (partText ? splitLines(partText) : []), [partText]);

  // Once a targeted line's text is actually on screen, scroll to it -- set
  // by clicking a bookmark (here or in Library's Recent Bookmarks) rather
  // than just landing on its part. partText === null (not just
  // !loading/!partTextLoading) matters here: right after switching books/
  // parts there's a render where loading and partTextLoading are both
  // momentarily false again but partText is still the *previous* part's
  // (useReaderBook clears it to null up front, before fetching the new one)
  // -- without this check this effect would fire against that stale content
  // and clear targetLine before the real text (and its line elements) ever
  // appears.
  useEffect(() => {
    if (loading || partTextLoading || partText === null || targetLine === null) return;
    document.getElementById(lineElementId(targetLine))?.scrollIntoView({ behavior: "smooth", block: "center" });
    clearTargetLine();
  }, [loading, partTextLoading, partText, targetLine, clearTargetLine]);
  const bookmarkedLines = useMemo(
    () => new Set(bookmarks.filter((b) => b.partNum === currentPartNum).map((b) => b.line)),
    [bookmarks, currentPartNum],
  );
  // The part-number box's width scales with partCount's own digit count
  // (1 part vs. 999 parts shouldn't share a box sized for the wider of the
  // two) rather than a fixed guess -- and maxLength tracks it so the box
  // never invites typing more digits than it can display.
  const partCountDigits = String(partCount || 1).length;
  // partCount starts at 0 until the first load resolves (see
  // useReaderBook.ts) -- "1 / 0" would misleadingly claim there's a known
  // current part out of a book with no parts, so show "-" for both instead
  // of a real-looking but meaningless number.
  const partCountKnown = partCount > 0;
  const seriesLabel = info?.series ? `${info.series}${info.seriesIndex ? `, #${info.seriesIndex}` : ""}` : null;
  // Calibre/OPF descriptions commonly carry HTML (see sanitizeHtml.ts) --
  // and this book's metadata may come from a document someone else shared
  // with this account, so it must be sanitized before rendering. The
  // collapsed preview uses the plain-text version so truncating at a
  // character count can't cut a tag in half; the expanded view uses the
  // full sanitized HTML so real formatting (bold/italic/lists/...) shows.
  const descriptionHtml = useMemo(
    () => (info?.description ? sanitizeDescriptionHtml(info.description) : null),
    [info?.description],
  );
  const descriptionPlain = useMemo(
    () => (info?.description ? descriptionPlainText(info.description) : null),
    [info?.description],
  );
  const descriptionIsLong = (descriptionPlain?.length ?? 0) > DESCRIPTION_PREVIEW_LEN;

  // Two independent dropdowns (Info and Bookmarks), but opening one should
  // still close the other -- useDropdown() itself has no notion of sibling
  // menus, so that coordination happens here.
  function toggleInfo() {
    infoMenu.toggle();
    bookmarksMenu.close();
  }

  function toggleBookmarks() {
    bookmarksMenu.toggle();
    infoMenu.close();
  }

  if (error) {
    return (
      <div className="shell-60 d-flex flex-column vh-100">
        <div className="border-bottom d-flex align-items-center gap-3 ps-2 ps-sm-3 pe-3 py-2">
          <button
            type="button"
            className="btn btn-link text-decoration-none px-0"
            onClick={() => navigate("/library")}
            aria-label="Back to library"
            title="Back to library"
          >
            <i className="bi bi-arrow-left" aria-hidden="true" />
          </button>
        </div>
        <div className="alert alert-danger m-4" role="alert">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="shell-60 d-flex flex-column vh-100">
      <div className="border-bottom d-flex align-items-center gap-3 ps-2 ps-sm-3 pe-3 py-2">
        <button
          type="button"
          className="btn btn-link text-decoration-none px-0"
          onClick={() => navigate("/library")}
          aria-label="Back to library"
          title="Back to library"
        >
          <i className="bi bi-arrow-left" aria-hidden="true" />
        </button>
        <div className="flex-grow-1 text-truncate">
          <div className="text-truncate">
            <span className="fw-semibold">{info?.title ?? `txt_${numericTxtId}`}</span>
            {info?.author && <span className="text-body-secondary d-none d-sm-inline"> / {info.author}</span>}
          </div>
          {/* Below sm there's no room to share a line with the title -- the
              author gets its own second line instead of being squeezed in. */}
          {info?.author && <div className="text-body-secondary small text-truncate d-sm-none">{info.author}</div>}
        </div>

        <div ref={infoMenu.ref} className="dropdown position-relative">
          <DropdownToggleButton
            open={infoMenu.open}
            onClick={toggleInfo}
            icon="bi-info-lg"
            ariaLabel="About this book"
            title="About this book"
          />
          {infoMenu.open && (
            <div
              className="dropdown-menu app-dropdown-menu show p-3"
              style={{ width: "20rem", maxWidth: "90vw", maxHeight: "70vh", overflowY: "auto" }}
            >
              <div className="fw-semibold">{info?.title ?? `txt_${numericTxtId}`}</div>
              {info?.author && <div>{info.author}</div>}
              {seriesLabel && <div className="text-body-secondary small">{seriesLabel}</div>}
              {info && info.subjects.length > 0 && (
                <div className="mt-2">
                  {info.subjects.map((subject) => (
                    <span key={subject} className="badge text-bg-secondary me-1 mb-1">
                      {subject}
                    </span>
                  ))}
                </div>
              )}
              {descriptionHtml && (
                <div className="fst-italic small mt-2">
                  {descriptionExpanded || !descriptionIsLong ? (
                    <span dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
                  ) : (
                    <span>{truncatePreview(descriptionPlain ?? "", DESCRIPTION_PREVIEW_LEN)}</span>
                  )}
                  {descriptionIsLong && (
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0 ms-1 align-baseline"
                      onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                    >
                      {descriptionExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                </div>
              )}
              {/* The curated fields above (title/author/series/subjects/
                  description) exist for their own special-purpose rendering;
                  this is the complete record underneath -- every OPF/Calibre
                  field this book's metadata carries, verbatim key and
                  values, so nothing from the catalog entry is hidden. */}
              {info && info.rawMetadata.length > 0 && (
                <div className="mt-3 pt-2 border-top">
                  <div className="text-body-secondary text-uppercase small fw-semibold mb-1">All metadata</div>
                  <div className="small">
                    {info.rawMetadata.map((field) => (
                      <div key={field.key} className="d-flex gap-2">
                        <span className="text-body-secondary text-nowrap">{field.key}</span>
                        <span className="text-truncate">{field.values.join(", ")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        ref={readingPaneRef}
        onScroll={handleReadingPaneScroll}
        className="flex-grow-1 overflow-auto ps-2 ps-sm-4 pe-4 py-4"
      >
        {/* maxWidth in `ch` (the width of "0" in this element's own font) --
            not a fixed rem value -- so the reading column's line length
            stays around 70 characters regardless of which font size is
            picked below, rather than cramming more characters per line into
            the same fixed pixel width at a smaller size (or fewer at a
            larger one). It's still a *max*-width: on a narrow viewport the
            column is capped by the available width same as before, just
            with fewer than 70 characters per line rather than overflowing. */}
        <div className="mx-auto reader-font" style={{ maxWidth: "70ch", fontSize: `${fontSizePx}px` }}>
          {!loading && (
            <div className="small text-body-secondary text-uppercase mb-3">
              Part {currentPartNum} of {partCount}
            </div>
          )}
          {!loading && info?.title && <h2 className="h4 mb-3">{info.title}</h2>}
          {(loading || partTextLoading) && (
            <div className="d-flex justify-content-center py-5">
              <div className="spinner-border text-primary" role="status">
                <span className="visually-hidden">Loading…</span>
              </div>
            </div>
          )}
          {!loading &&
            !partTextLoading &&
            lines.map((line, i) => {
              const lineNum = i + 1;
              const isBookmarked = bookmarkedLines.has(lineNum);
              return (
                <div key={lineNum} id={lineElementId(lineNum)} className="reader-line d-flex align-items-start gap-2">
                  <button
                    type="button"
                    className={`bookmark-toggle btn btn-sm p-0 border-0 bg-transparent lh-1 mt-1 ${
                      isBookmarked ? "is-bookmarked text-primary" : "text-body-tertiary"
                    }`}
                    onClick={() => bookmarkLine(lineNum, truncatePreview(line))}
                    aria-pressed={isBookmarked}
                    aria-label={`Bookmark line ${lineNum}`}
                    title={`Bookmark line ${lineNum}`}
                  >
                    <i className={`bi ${isBookmarked ? "bi-bookmark-fill" : "bi-bookmark"}`} aria-hidden="true" />
                  </button>
                  <p className="flex-grow-1">{line}</p>
                </div>
              );
            })}
        </div>
      </div>

      {/* Below sm, d-none/d-flex here follows bottomBarHidden; d-sm-flex
          always wins at sm+ regardless of it -- the auto-hide behavior (see
          handleReadingPaneScroll) only ever applies on a phone-sized
          screen. */}
      <div
        className={`border-top align-items-center gap-2 gap-sm-3 ps-2 ps-sm-3 pe-3 py-2 d-sm-flex ${bottomBarHidden ? "d-none" : "d-flex"}`}
      >
        <select
          className="form-select form-select-sm themed-control font-size-select"
          style={{ width: "4.25rem" }}
          value={fontSizePx}
          onChange={(event) => setFontSizePx(Number(event.target.value))}
          aria-label="Font size"
        >
          {FONT_SIZES_PX.map((size) => (
            <option key={size} value={size}>
              {size}px
            </option>
          ))}
        </select>

        <div className="vr bottom-bar-vr" />

        {/* Previous/part-box/Next stay tightly grouped (gap-1) -- they're
            one control, unlike the looser gap-2/gap-sm-3 spacing the outer
            bar uses around the font-size dropdown, this group, and the vr
            dividers on either side of it. */}
        <div className="d-flex align-items-center gap-1">
          <button
            type="button"
            className="btn btn-sm btn-link p-0 text-decoration-none"
            onClick={previous}
            disabled={loading || currentPartNum <= 1}
            aria-label="Previous part"
          >
            <i className="bi bi-chevron-left text-primary" aria-hidden="true" />
          </button>

          <div className="d-flex align-items-center gap-1 text-body-secondary small text-nowrap">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={partCountDigits}
              className="form-control form-control-sm themed-control text-center"
              style={{ width: `calc(${partCountDigits}ch + 2rem)` }}
              value={partCountKnown ? partInput : "-"}
              disabled={loading || !partCountKnown}
              onChange={(event) => setPartInput(event.target.value.replace(/\D/g, "").slice(0, partCountDigits))}
              onBlur={commitPartInput}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitPartInput();
                  event.currentTarget.blur();
                }
              }}
              aria-label="Go to part"
            />
            <span>/ {partCountKnown ? partCount : "-"}</span>
          </div>

          <button
            type="button"
            className="btn btn-sm btn-link p-0 text-decoration-none"
            onClick={next}
            disabled={loading || currentPartNum >= partCount}
            aria-label="Next part"
          >
            <i className="bi bi-chevron-right text-primary" aria-hidden="true" />
          </button>
        </div>

        <div className="vr bottom-bar-vr" />

        <div ref={bookmarksMenu.ref} className="dropdown position-relative ms-auto">
          <DropdownToggleButton
            open={bookmarksMenu.open}
            onClick={toggleBookmarks}
            icon={bookmarks.length > 0 ? "bi-bookmark-fill" : "bi-bookmark"}
            ariaLabel="Bookmarks"
            title="Bookmarks"
          />
          {bookmarksMenu.open && (
            <div
              className="dropdown-menu app-dropdown-menu app-dropdown-menu-up show p-3"
              style={{ width: "20rem", maxWidth: "90vw", maxHeight: "70vh", overflowY: "auto" }}
            >
              {bookmarks.length === 0 && <p className="small text-body-secondary mb-0">No bookmarks yet.</p>}
              {bookmarks.map((bookmark) => (
                <BookmarkRow
                  key={bookmark.createdAt}
                  partNum={bookmark.partNum}
                  line={bookmark.line}
                  txtPreview={bookmark.txtPreview}
                  onClick={() => goToBookmark(bookmark.partNum, bookmark.line)}
                  onDelete={() => removeBookmark(bookmark.createdAt)}
                  deleteAriaLabel={`Remove this bookmark (part ${bookmark.partNum}, line ${bookmark.line})`}
                  className="d-flex align-items-start gap-2 mb-2 w-100"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Takes the bottom bar's place (Bookmarks in particular) while it's
          auto-hidden on a phone -- see bottomBarHidden above. d-sm-none is
          belt-and-suspenders: bottomBarHidden always resets on part/book
          change, but this keeps the button phone-only even if that timing
          ever drifted. */}
      {bottomBarHidden && (
        <button
          type="button"
          className="btn btn-primary btn-sm rounded-circle position-fixed bottom-0 end-0 m-3 d-sm-none shadow d-flex align-items-center justify-content-center p-0"
          style={{ width: "2.75rem", height: "2.75rem", zIndex: 1030 }}
          onClick={scrollToTop}
          aria-label="Scroll to top"
          title="Scroll to top"
        >
          {/* Bootstrap's stock white icon color reads fine against light
              mode's dark fill but washes out against dark mode's much
              lighter gold one -- --brass-icon-on-fill picks the right
              color per theme instead (theme.css). Sized up a bit from the
              button's own font-size so the arrow itself reads clearly at
              this button's small footprint. */}
          <i
            className="bi bi-arrow-up"
            style={{ color: "var(--brass-icon-on-fill)", fontSize: "1.2rem" }}
            aria-hidden="true"
          />
        </button>
      )}
    </div>
  );
}
