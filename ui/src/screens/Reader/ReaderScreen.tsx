// Renders the requested document with epub.js: page navigation, a table of
// contents, book info, column layout, and font size controls.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import { EpubRenderer } from "../../data/epubRenderer";
import { useVault } from "../../state/VaultContext";
import { TocPanel } from "./TocPanel";
import { useReaderDocument } from "./useReaderDocument";

const MOBILE_MEDIA_QUERY = "(max-width: 767.98px)";
const DESKTOP_FONT_PX = 18;
const MOBILE_FONT_PX = 16;
const MIN_FONT_PX = 12;
const MAX_FONT_PX = 32;
const FONT_STEP_PX = 1;

function defaultFontPx(): number {
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches
    ? MOBILE_FONT_PX
    : DESKTOP_FONT_PX;
}

export function ReaderScreen() {
  const { txtId } = useParams<{ txtId: string }>();
  const { session } = useVault();
  const { status, document, error } = useReaderDocument(session, Number(txtId));
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<EpubRenderer | null>(null);
  const [fontPx, setFontPx] = useState(defaultFontPx);
  const [columns, setColumns] = useState<1 | 2>(1);
  const [infoOpen, setInfoOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

  useEffect(() => {
    if (status !== "ready" || !document || !containerRef.current) return;
    const newRenderer = new EpubRenderer(document.epubBytes);
    newRenderer.renderTo(containerRef.current);
    newRenderer.setFontSize(`${fontPx}px`);
    newRenderer.setColumns(columns);
    setRenderer(newRenderer);

    function handleKeyup(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") void newRenderer.prev();
      if (event.key === "ArrowRight") void newRenderer.next();
    }
    window.addEventListener("keyup", handleKeyup);
    newRenderer.onKeyup(handleKeyup);

    return () => {
      window.removeEventListener("keyup", handleKeyup);
      newRenderer.destroy();
      setRenderer(null);
    };
    // fontPx/columns are only applied at mount here (their initial value);
    // adjustFontSize()/toggleColumns() call the already-mounted renderer's
    // methods directly, so changing them shouldn't remount the renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, document]);

  function adjustFontSize(delta: number) {
    const next = Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, fontPx + delta));
    setFontPx(next);
    renderer?.setFontSize(`${next}px`);
  }

  function toggleColumns() {
    const next = columns === 1 ? 2 : 1;
    setColumns(next);
    renderer?.setColumns(next);
  }

  if (status === "loading") {
    return (
      <div className="container py-5 text-center text-muted">
        <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
        Opening your book…
      </div>
    );
  }
  if (status === "not-found") {
    return (
      <p className="container py-5 text-center text-muted">
        This document could not be found.
      </p>
    );
  }
  if (status === "error") {
    return (
      <p role="alert" className="container py-5 alert alert-danger">
        {error}
      </p>
    );
  }

  return (
    <div className="d-flex flex-column vh-100 mx-auto" style={{ maxWidth: "80%" }}>
      <div className="d-flex align-items-center border-bottom px-2 py-1 gap-1">
        <Link
          to="/library"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Back to library"
        >
          <i className="bi bi-arrow-left" />
        </Link>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Previous page"
          onClick={() => void renderer?.prev()}
        >
          <i className="bi bi-chevron-left" />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Next page"
          onClick={() => void renderer?.next()}
        >
          <i className="bi bi-chevron-right" />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Decrease font size"
          onClick={() => adjustFontSize(-FONT_STEP_PX)}
        >
          <i className="bi bi-dash" />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Increase font size"
          onClick={() => adjustFontSize(FONT_STEP_PX)}
        >
          <i className="bi bi-plus" />
        </button>
        <button
          type="button"
          className={`btn btn-sm btn-outline-secondary ${columns === 2 ? "active" : ""}`}
          aria-pressed={columns === 2}
          aria-label="Two-column layout"
          onClick={toggleColumns}
        >
          <i className="bi bi-columns-gap" />
        </button>
        <h1 className="h6 mb-0 mx-2 text-truncate flex-grow-1">{document!.title}</h1>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Contents"
          onClick={() => setTocOpen(true)}
        >
          <i className="bi bi-list" />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Book info"
          onClick={() => setInfoOpen(true)}
        >
          <i className="bi bi-info-circle" />
        </button>
      </div>

      <div ref={containerRef} className="flex-grow-1" />

      <OffcanvasPanel open={infoOpen} onClose={() => setInfoOpen(false)} title="Info">
        <dl className="mb-0">
          <dt>Title</dt>
          <dd>{document!.title}</dd>
          {document!.authors.length > 0 && (
            <>
              <dt>Author{document!.authors.length > 1 ? "s" : ""}</dt>
              <dd>{document!.authors.join(", ")}</dd>
            </>
          )}
          {document!.publisher && (
            <>
              <dt>Publisher</dt>
              <dd>{document!.publisher}</dd>
            </>
          )}
          {document!.subjects.length > 0 && (
            <>
              <dt>Subjects</dt>
              <dd>{document!.subjects.join(", ")}</dd>
            </>
          )}
        </dl>
      </OffcanvasPanel>
      <TocPanel open={tocOpen} onClose={() => setTocOpen(false)} renderer={renderer} />
    </div>
  );
}
