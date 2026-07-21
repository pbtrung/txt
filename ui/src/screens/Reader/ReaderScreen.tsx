// Screen 3 -- Reader (docs/ui.md): a reading pane with a part-navigation bar
// along the bottom. "About this book" and "Bookmarks" are two independent
// dropdowns anchored to their own top-bar buttons (closed by default) --
// there's no persistent side panel; the reading pane is always full width.
//
// Bookmarking is per-line (docs/data_model.md's bookmarks: {part_num, line,
// txt_preview}), not per-part: each line in the reading pane has its own
// gutter bookmark button, so "bookmark by line number" is just "click the
// line's own icon" -- no separate number-entry control needed.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ProgressBar } from "../../components/ProgressBar";
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
  const menusRef = useRef<HTMLDivElement>(null);

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
    goToBookmark,
    next,
    previous,
    bookmarkLine,
    removeBookmark,
  } = useReaderBook(numericTxtId);

  // A fresh book starts with its description collapsed again.
  useEffect(() => setDescriptionExpanded(false), [numericTxtId]);

  // Closing on an outside click/Escape is what makes these read as dropdowns
  // rather than plain toggle panels -- there's no Bootstrap JS in this
  // project (only its CSS), so both the open/closed state and this behavior
  // are hand-rolled instead of relying on its dropdown plugin.
  useEffect(() => {
    if (!infoOpen && !bookmarksOpen) return;
    function closeMenus() {
      setInfoOpen(false);
      setBookmarksOpen(false);
    }
    function handlePointerDown(event: MouseEvent) {
      if (menusRef.current && !menusRef.current.contains(event.target as Node)) closeMenus();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenus();
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
  const progressPercent = partCount > 0 ? Math.round((currentPartNum / partCount) * 100) : 0;
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
      <div className="border-bottom d-flex align-items-center gap-3 px-3 py-2">
        <button type="button" className="btn btn-link text-decoration-none px-0" onClick={() => navigate("/library")}>
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          Library
        </button>
        <div className="flex-grow-1 text-truncate">
          <span className="fw-semibold">{info?.title ?? `txt_${numericTxtId}`}</span>
          {info?.author && <span className="text-body-secondary"> / {info.author}</span>}
        </div>

        <div ref={menusRef} className="d-flex align-items-center gap-2">
          <div className="dropdown position-relative">
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
                className="dropdown-menu reader-dropdown-menu show p-3"
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

          <div className="dropdown position-relative">
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
                className="dropdown-menu reader-dropdown-menu show p-3"
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
      </div>

      <div className="flex-grow-1 overflow-auto px-4 py-4">
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

      <div className="border-top d-flex align-items-center gap-2 gap-sm-3 px-3 py-2">
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={previous}
          disabled={loading || currentPartNum <= 1}
          aria-label="Previous part"
        >
          <i className="bi bi-chevron-left d-sm-none" aria-hidden="true" />
          <span className="d-none d-sm-inline">
            <i className="bi bi-chevron-left me-1" aria-hidden="true" />
            Previous
          </span>
        </button>
        <span className="text-body-secondary small text-nowrap">
          Part {currentPartNum} / {partCount}
        </span>
        <div className="flex-grow-1">
          <ProgressBar percent={progressPercent} />
        </div>
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={next}
          disabled={loading || currentPartNum >= partCount}
          aria-label="Next part"
        >
          <i className="bi bi-chevron-right d-sm-none" aria-hidden="true" />
          <span className="d-none d-sm-inline">
            Next
            <i className="bi bi-chevron-right ms-1" aria-hidden="true" />
          </span>
        </button>
      </div>
    </div>
  );
}
