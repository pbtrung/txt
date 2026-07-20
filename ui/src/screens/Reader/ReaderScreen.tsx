// Screen 3 -- Reader (docs/ui.md): a reading pane on the left, a slim
// metadata/bookmarks panel on the right, a part-navigation bar along the
// bottom.

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ProgressBar } from "../../components/ProgressBar";
import { formatRelativeTime } from "./readerModel";
import { useReaderBook } from "./useReaderBook";

export function ReaderScreen() {
  const { txtId } = useParams();
  const navigate = useNavigate();
  const numericTxtId = Number(txtId);
  const [sidePanelOpen, setSidePanelOpen] = useState(true);

  const {
    loading,
    error,
    info,
    partCount,
    currentPartNum,
    partText,
    partTextLoading,
    bookmarks,
    next,
    previous,
    bookmarkCurrentPart,
  } = useReaderBook(numericTxtId);

  const paragraphs = useMemo(() => (partText ? partText.split(/\n{2,}/).filter(Boolean) : []), [partText]);
  const isBookmarked = bookmarks.some((b) => b.partNum === currentPartNum);
  const progressPercent = partCount > 0 ? Math.round((currentPartNum / partCount) * 100) : 0;
  const seriesLabel = info?.series ? `${info.series}${info.seriesIndex ? `, #${info.seriesIndex}` : ""}` : null;

  if (loading) {
    return <p className="text-body-secondary p-4">Loading…</p>;
  }
  if (error) {
    return (
      <div className="alert alert-danger m-4" role="alert">
        {error}
      </div>
    );
  }

  return (
    <div className="d-flex flex-column vh-100">
      <div className="border-bottom d-flex align-items-center gap-3 px-3 py-2">
        <button type="button" className="btn btn-link text-decoration-none px-0" onClick={() => navigate("/library")}>
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          Library
        </button>
        <div className="flex-grow-1 text-truncate">
          <span className="fw-semibold">{info?.title ?? `txt_${numericTxtId}`}</span>
          {info?.author && <span className="text-body-secondary"> / {info.author}</span>}
        </div>
        <button
          type="button"
          className={`btn btn-sm ${isBookmarked ? "btn-primary" : "btn-outline-secondary"}`}
          onClick={bookmarkCurrentPart}
          aria-pressed={isBookmarked}
          aria-label="Bookmark this part"
          title="Bookmark this part"
        >
          <i className="bi bi-bookmark-fill" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`btn btn-sm ${sidePanelOpen ? "btn-primary" : "btn-outline-secondary"}`}
          onClick={() => setSidePanelOpen((open) => !open)}
          aria-pressed={sidePanelOpen}
          aria-label="About this book"
          title="About this book"
        >
          <i className="bi bi-info-lg" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-grow-1 d-flex overflow-hidden">
        <div className="flex-grow-1 overflow-auto px-4 py-4">
          <div className="mx-auto" style={{ maxWidth: "42rem" }}>
            <div className="small text-body-secondary text-uppercase mb-3">
              Part {currentPartNum} of {partCount}
            </div>
            {info?.title && <h2 className="h4 mb-3">{info.title}</h2>}
            {partTextLoading && <p className="text-body-secondary">Loading part…</p>}
            {!partTextLoading && paragraphs.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </div>

        {sidePanelOpen && (
          <div className="border-start p-3 overflow-auto d-none d-md-block" style={{ width: "18rem" }}>
            <div className="small text-body-secondary text-uppercase fw-semibold mb-2">About this book</div>
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
            {info?.description && <p className="fst-italic small mt-2">&ldquo;{info.description}&rdquo;</p>}

            <div className="small text-body-secondary text-uppercase fw-semibold mt-4 mb-2">Bookmarks</div>
            {bookmarks.length === 0 && <p className="small text-body-secondary">No bookmarks yet.</p>}
            {bookmarks.map((bookmark) => (
              <div key={bookmark.id} className="d-flex align-items-start gap-2 mb-2">
                <i className="bi bi-bookmark-fill text-primary" aria-hidden="true" />
                <div>
                  <div className="small">Part {bookmark.partNum}</div>
                  <div className="text-body-secondary" style={{ fontSize: "0.75rem" }}>
                    {formatRelativeTime(bookmark.createdAtMs, Date.now())}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-top d-flex align-items-center gap-3 px-3 py-2">
        <button type="button" className="btn btn-outline-secondary" onClick={previous} disabled={currentPartNum <= 1}>
          <i className="bi bi-chevron-left me-1" aria-hidden="true" />
          Previous
        </button>
        <span className="text-body-secondary small text-nowrap">
          Part {currentPartNum} / {partCount}
        </span>
        <div className="flex-grow-1">
          <ProgressBar percent={progressPercent} />
        </div>
        <button type="button" className="btn btn-outline-secondary" onClick={next} disabled={currentPartNum >= partCount}>
          Next
          <i className="bi bi-chevron-right ms-1" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
