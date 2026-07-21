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
import { useNavigate, useParams } from "react-router-dom";

import { splitLines, truncatePreview } from "./readerModel";
import { descriptionPlainText, sanitizeDescriptionHtml } from "./sanitizeHtml";
import { useReaderBook } from "./useReaderBook";

function lineElementId(lineNum: number): string {
  return `reader-line-${lineNum}`;
}

const DESCRIPTION_PREVIEW_LEN = 200;

export function ReaderScreen() {
  const { txtId } = useParams();
  const navigate = useNavigate();
  const numericTxtId = Number(txtId);
  const [infoOpen, setInfoOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const infoMenuRef = useRef<HTMLDivElement>(null);
  const bookmarksMenuRef = useRef<HTMLDivElement>(null);

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

  // Closing on an outside click/Escape is what makes these read as dropdowns
  // rather than plain toggle panels -- there's no Bootstrap JS in this
  // project (only its CSS), so both the open/closed state and this behavior
  // are hand-rolled instead of relying on its dropdown plugin. Each menu
  // gets its own ref (they're not DOM siblings -- one's in the top bar, the
  // other's in the bottom bar) so a click inside one doesn't close the other.
  useEffect(() => {
    if (!infoOpen && !bookmarksOpen) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (infoOpen && infoMenuRef.current && !infoMenuRef.current.contains(target)) {
        setInfoOpen(false);
      }
      if (bookmarksOpen && bookmarksMenuRef.current && !bookmarksMenuRef.current.contains(target)) {
        setBookmarksOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setInfoOpen(false);
        setBookmarksOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [infoOpen, bookmarksOpen]);

  const lines = useMemo(() => (partText ? splitLines(partText) : []), [partText]);

  // Once a targeted line's text is actually on screen, scroll to it and
  // flash-highlight it briefly -- set by clicking a bookmark (here or in
  // Library's Recent Bookmarks) rather than just landing on its part.
  // partText === null (not just !loading/!partTextLoading) matters here:
  // right after switching books/parts there's a render where loading and
  // partTextLoading are both momentarily false again but partText is still
  // the *previous* part's (useReaderBook clears it to null up front, before
  // fetching the new one) -- without this check this effect would fire
  // against that stale content and clear targetLine before the real text
  // (and its line elements) ever appears.
  useEffect(() => {
    if (loading || partTextLoading || partText === null || targetLine === null) return;
    document.getElementById(lineElementId(targetLine))?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedLine(targetLine);
    clearTargetLine();
    const timer = setTimeout(() => setHighlightedLine(null), 1500);
    return () => clearTimeout(timer);
  }, [loading, partTextLoading, partText, targetLine, clearTargetLine]);
  const bookmarkedLines = useMemo(
    () => new Set(bookmarks.filter((b) => b.partNum === currentPartNum).map((b) => b.line)),
    [bookmarks, currentPartNum],
  );
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

  function toggleInfo() {
    setInfoOpen((open) => !open);
    setBookmarksOpen(false);
  }

  function toggleBookmarks() {
    setBookmarksOpen((open) => !open);
    setInfoOpen(false);
  }

  if (error) {
    return (
      <div className="alert alert-danger m-4" role="alert">
        {error}
      </div>
    );
  }

  return (
    <div className="shell-80 d-flex flex-column vh-100">
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

        <div ref={infoMenuRef} className="dropdown position-relative">
          <button
            type="button"
            className={`btn btn-sm ${infoOpen ? "btn-primary" : "btn-outline-secondary"}`}
            onClick={toggleInfo}
            aria-expanded={infoOpen}
            aria-haspopup="true"
            aria-label="About this book"
            title="About this book"
          >
            <i className="bi bi-info-lg" aria-hidden="true" />
          </button>
          {infoOpen && (
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
            </div>
          )}
        </div>
      </div>

      <div className="flex-grow-1 overflow-auto ps-2 ps-sm-4 pe-4 py-4">
        <div className="mx-auto" style={{ maxWidth: "42rem" }}>
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
                <div
                  key={lineNum}
                  id={lineElementId(lineNum)}
                  className={`reader-line d-flex align-items-start gap-2 ${
                    highlightedLine === lineNum ? "is-highlighted" : ""
                  }`}
                >
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

      <div className="border-top d-flex align-items-center gap-2 gap-sm-3 ps-2 ps-sm-3 pe-3 py-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={previous}
          disabled={loading || currentPartNum <= 1}
          aria-label="Previous part"
        >
          <i className="bi bi-chevron-left" aria-hidden="true" />
        </button>

        <div className="d-flex align-items-center gap-1 text-body-secondary small text-nowrap">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            className="form-control form-control-sm text-center"
            style={{ width: "3.5rem" }}
            value={partInput}
            disabled={loading}
            onChange={(event) => setPartInput(event.target.value.replace(/\D/g, "").slice(0, 3))}
            onBlur={commitPartInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitPartInput();
                event.currentTarget.blur();
              }
            }}
            aria-label="Go to part"
          />
          <span>/ {partCount}</span>
        </div>

        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={next}
          disabled={loading || currentPartNum >= partCount}
          aria-label="Next part"
        >
          <i className="bi bi-chevron-right" aria-hidden="true" />
        </button>

        <div ref={bookmarksMenuRef} className="dropdown position-relative ms-auto">
          <button
            type="button"
            className={`btn btn-sm ${bookmarksOpen ? "btn-primary" : "btn-outline-secondary"}`}
            onClick={toggleBookmarks}
            aria-expanded={bookmarksOpen}
            aria-haspopup="true"
            aria-label="Bookmarks"
            title="Bookmarks"
          >
            <i className={`bi ${bookmarks.length > 0 ? "bi-bookmark-fill" : "bi-bookmark"}`} aria-hidden="true" />
          </button>
          {bookmarksOpen && (
            <div
              className="dropdown-menu app-dropdown-menu app-dropdown-menu-up show p-3"
              style={{ width: "20rem", maxWidth: "90vw", maxHeight: "70vh", overflowY: "auto" }}
            >
              {bookmarks.length === 0 && <p className="small text-body-secondary mb-0">No bookmarks yet.</p>}
              {bookmarks.map((bookmark) => (
                // A plain button can't contain the nested delete button below.
                <div
                  key={bookmark.createdAt}
                  role="button"
                  tabIndex={0}
                  className="d-flex align-items-start gap-2 mb-2 w-100"
                  onClick={() => goToBookmark(bookmark.partNum, bookmark.line)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      goToBookmark(bookmark.partNum, bookmark.line);
                    }
                  }}
                >
                  <i className="bi bi-bookmark-fill text-primary mt-1" aria-hidden="true" />
                  <span className="flex-grow-1">
                    <span className="small d-block">
                      Part {bookmark.partNum} · Line {bookmark.line}
                    </span>
                    <span className="text-body-secondary fst-italic" style={{ fontSize: "0.75rem" }}>
                      &ldquo;{bookmark.txtPreview}&rdquo;
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-xs btn-outline-secondary border-0 flex-shrink-0"
                    aria-label={`Remove this bookmark (part ${bookmark.partNum}, line ${bookmark.line})`}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeBookmark(bookmark.createdAt);
                    }}
                  >
                    <i className="bi bi-x-lg" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
