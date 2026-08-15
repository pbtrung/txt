// Renders the requested document with epub.js: page navigation, a table of
// contents, book info, and font size controls.
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import { EpubRenderer } from "../../data/epubRenderer";
import { useVault } from "../../state/VaultContext";
import { TocPanel } from "./TocPanel";
import { useReaderDocument } from "./useReaderDocument";

const MIN_FONT_PERCENT = 50;
const MAX_FONT_PERCENT = 300;
const FONT_STEP_PERCENT = 10;

export function ReaderScreen() {
  const { txtId } = useParams<{ txtId: string }>();
  const { session } = useVault();
  const { status, document, error } = useReaderDocument(session, Number(txtId));
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<EpubRenderer | null>(null);
  const [fontPercent, setFontPercent] = useState(100);
  const [infoOpen, setInfoOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

  useEffect(() => {
    if (status !== "ready" || !document || !containerRef.current) return;
    const newRenderer = new EpubRenderer(document.epubBytes);
    newRenderer.renderTo(containerRef.current);
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
  }, [status, document]);

  function adjustFontSize(delta: number) {
    const next = Math.min(
      MAX_FONT_PERCENT,
      Math.max(MIN_FONT_PERCENT, fontPercent + delta),
    );
    setFontPercent(next);
    renderer?.setFontSize(`${next}%`);
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
    <div className="d-flex flex-column vh-100">
      <div className="d-flex align-items-center border-bottom px-2 py-1 gap-1">
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
          onClick={() => adjustFontSize(-FONT_STEP_PERCENT)}
        >
          <i className="bi bi-dash" />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Increase font size"
          onClick={() => adjustFontSize(FONT_STEP_PERCENT)}
        >
          <i className="bi bi-plus" />
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
