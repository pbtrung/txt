// Renders the requested document with epub.js: page navigation, a table of
// contents, book info, column layout, and font size controls. Font/column
// controls live behind one "Display" dropdown rather than sitting in the
// toolbar directly -- five always-visible icon buttons plus the title
// leaves more room to breathe than nine would, especially on a narrow
// screen.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import { EpubRenderer } from "../../data/epubRenderer";
import type { MetadataField } from "../../data/readerDocument";
import { sanitizeHtml, stripHtmlToText } from "../../data/sanitizeHtml";
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
  const [columns, setColumns] = useState<1 | 2>(2);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

  useEffect(() => {
    if (status !== "ready" || !document || !containerRef.current) return;
    const newRenderer = new EpubRenderer(
      document.epubBytes,
      document.title,
      document.authors,
    );
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
    <div className="d-flex flex-column vh-100 mx-auto max-w-md-80 px-2 px-md-0">
      <div className="d-flex align-items-center border-bottom py-1 gap-1">
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
        <h1 className="h6 mb-0 mx-2 text-truncate flex-grow-1">{document!.title}</h1>
        <DisplayMenu
          open={displayOpen}
          onToggle={() => setDisplayOpen((v) => !v)}
          onDecreaseFont={() => adjustFontSize(-FONT_STEP_PX)}
          onIncreaseFont={() => adjustFontSize(FONT_STEP_PX)}
          columns={columns}
          onToggleColumns={toggleColumns}
        />
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

      <InfoPanel
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        document={document!}
      />
      <TocPanel open={tocOpen} onClose={() => setTocOpen(false)} renderer={renderer} />
    </div>
  );
}

function DisplayMenu({
  open,
  onToggle,
  onDecreaseFont,
  onIncreaseFont,
  columns,
  onToggleColumns,
}: {
  open: boolean;
  onToggle: () => void;
  onDecreaseFont: () => void;
  onIncreaseFont: () => void;
  columns: 1 | 2;
  onToggleColumns: () => void;
}) {
  return (
    <div className="dropdown">
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        aria-label="Display settings"
        aria-expanded={open}
        onClick={onToggle}
      >
        <i className="bi bi-textarea-t" />
      </button>
      <div
        className={`dropdown-menu dropdown-menu-end p-3 ${open ? "show" : ""}`}
        style={{ minWidth: "14rem" }}
      >
        <div className="d-flex align-items-center justify-content-between gap-3 mb-3">
          <span className="small text-muted">Font size</span>
          <div>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-label="Decrease font size"
              onClick={onDecreaseFont}
            >
              <i className="bi bi-dash" />
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary ms-1"
              aria-label="Increase font size"
              onClick={onIncreaseFont}
            >
              <i className="bi bi-plus" />
            </button>
          </div>
        </div>
        <div className="d-flex align-items-center justify-content-between gap-3">
          <span className="small text-muted">Two columns</span>
          <button
            type="button"
            className={`btn btn-sm btn-outline-secondary ${columns === 2 ? "active" : ""}`}
            aria-pressed={columns === 2}
            aria-label="Two-column layout"
            onClick={onToggleColumns}
          >
            <i className="bi bi-columns-gap" />
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoPanel({
  open,
  onClose,
  document,
}: {
  open: boolean;
  onClose: () => void;
  document: {
    title: string;
    authors: string[];
    subjects: string[];
    publisher: string | null;
    extraMetadata: MetadataField[];
  };
}) {
  return (
    <OffcanvasPanel open={open} onClose={onClose} title="Info">
      <h2 className="h5 mb-1">{document.title}</h2>
      {document.authors.length > 0 && (
        <p className="text-muted mb-3">{document.authors.join(", ")}</p>
      )}
      <dl className="small mb-0">
        {document.publisher && (
          <MetadataGroup label="Publisher" value={document.publisher} />
        )}
        {document.subjects.length > 0 && (
          <MetadataGroup label="Subjects" value={document.subjects.join(", ")} />
        )}
        {document.extraMetadata.map((field, i) => (
          <MetadataGroup
            key={`${field.label}-${i}`}
            label={field.label}
            value={field.values.join(", ")}
            html={field.label === "Description"}
          />
        ))}
      </dl>
    </OffcanvasPanel>
  );
}

const DESCRIPTION_PREVIEW_LENGTH = 300;

function MetadataGroup({
  label,
  value,
  html = false,
}: {
  label: string;
  value: string;
  html?: boolean;
}) {
  return (
    <div className="mb-3">
      <dt className="text-muted fw-normal">{label}</dt>
      <dd className="mb-0">{html ? <TruncatedHtml html={value} /> : value}</dd>
    </div>
  );
}

// Calibre's own dc:description is commonly rich HTML, not plain text; the
// 300-character truncation works off a plain-text rendering of it (via
// stripHtmlToText) rather than slicing the raw markup, which would risk
// cutting a tag in half. Only the expanded state ever renders the actual
// sanitized HTML.
function TruncatedHtml({ html }: { html: string }) {
  const [expanded, setExpanded] = useState(false);
  const plainText = stripHtmlToText(html);

  if (plainText.length <= DESCRIPTION_PREVIEW_LENGTH) {
    return <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
  }
  if (!expanded) {
    return (
      <>
        {plainText.slice(0, DESCRIPTION_PREVIEW_LENGTH)}…{" "}
        <button
          type="button"
          className="btn btn-link btn-sm p-0 align-baseline"
          onClick={() => setExpanded(true)}
        >
          Show more
        </button>
      </>
    );
  }
  return (
    <>
      <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />{" "}
      <button
        type="button"
        className="btn btn-link btn-sm p-0 align-baseline"
        onClick={() => setExpanded(false)}
      >
        Show less
      </button>
    </>
  );
}
