// Renders the requested document with epub.js. The header stays to three
// controls (back, menu, info); Contents lives in the left menu, while font
// size and book-wide page navigation share a compact bottom bar.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import { EpubRenderer, type PagePosition } from "../../data/epubRenderer";
import type { MetadataField } from "../../data/readerDocument";
import { sanitizeHtml, stripHtmlToText } from "../../data/sanitizeHtml";
import { useVault } from "../../state/VaultContext";
import { TocPanel } from "./TocPanel";
import { useReaderDocument } from "./useReaderDocument";

const MOBILE_MEDIA_QUERY = "(max-width: 767.98px)";
const DESKTOP_FONT_PX = 18;
const MOBILE_FONT_PX = 16;
const FONT_SIZES_PX = [16, 18, 20, 22, 24] as const;
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
  const [page, setPage] = useState<PagePosition>({ current: 1, total: 1 });
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
    newRenderer.setColumns(2);
    newRenderer.onPageChange(setPage);
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
    // Font changes are applied directly by changeFontSize; they do not
    // replace the renderer or restart the book-wide page map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, document]);

  function changeFontSize(next: number) {
    setFontPx(next);
    renderer?.setFontSize(`${next}px`);
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
      <div className="reader-toolbar d-flex align-items-center border-bottom py-1 gap-1">
        <Link
          to="/library"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Back to library"
        >
          <i className="bi bi-arrow-left" />
        </Link>
        <h1 className="h6 mb-0 mx-2 text-truncate flex-grow-1">
          {readerTitle(document!.title, document!.authors)}
        </h1>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-label="Menu"
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

      <PageNavigation
        renderer={renderer}
        page={page}
        fontPx={fontPx}
        onFontSize={changeFontSize}
      />

      <InfoPanel
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        document={document!}
      />
      <TocPanel open={tocOpen} onClose={() => setTocOpen(false)} renderer={renderer} />
    </div>
  );
}

function readerTitle(title: string, authors: string[]): string {
  return authors.length > 0 ? `${title} — ${authors.join(", ")}` : title;
}

function PageNavigation({
  renderer,
  page,
  fontPx,
  onFontSize,
}: {
  renderer: EpubRenderer | null;
  page: PagePosition;
  fontPx: number;
  onFontSize: (size: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  useEffect(() => {
    if (inputRef.current) inputRef.current.value = String(page.current);
  }, [page]);

  function goToInputPage() {
    const value = Number(inputRef.current?.value);
    if (Number.isInteger(value) && value >= 1 && value <= page.total)
      void renderer?.displayPage(value);
    else if (inputRef.current) inputRef.current.value = String(page.current);
  }

  return (
    <div className="d-flex align-items-center justify-content-start border-top py-1 gap-2">
      <div className="dropup">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary dropdown-toggle"
          aria-label="Font size"
          aria-haspopup="menu"
          aria-expanded={fontMenuOpen}
          onClick={() => setFontMenuOpen((open) => !open)}
        >
          {fontPx}px
        </button>
        <ul
          role="menu"
          className={`dropdown-menu${fontMenuOpen ? " show" : ""}`}
          aria-label="Font size options"
          style={{ bottom: "100%", top: "auto" }}
        >
          {FONT_SIZES_PX.map((size) => (
            <li key={size}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={fontPx === size}
                className={`dropdown-item${fontPx === size ? " active" : ""}`}
                onClick={() => {
                  onFontSize(size);
                  setFontMenuOpen(false);
                }}
              >
                {size}px
              </button>
            </li>
          ))}
        </ul>
      </div>
      <span className="vr" aria-hidden="true" />
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        aria-label="Previous page"
        disabled={!renderer}
        onClick={() => void renderer?.prev()}
      >
        <i className="bi bi-chevron-left" />
      </button>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className="form-control form-control-sm text-end"
        aria-label="Current page"
        defaultValue={page.current}
        style={{ width: `calc(${String(page.total).length}ch + 1.5rem)` }}
        onBlur={goToInputPage}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span className="small text-muted" aria-label={`Total pages ${page.total}`}>
        / {page.total}
      </span>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary"
        aria-label="Next page"
        disabled={!renderer}
        onClick={() => void renderer?.next()}
      >
        <i className="bi bi-chevron-right" />
      </button>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary ms-auto"
        aria-label="Bookmark"
      >
        <i className="bi bi-bookmark" />
      </button>
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
    <OffcanvasPanel
      open={open}
      onClose={onClose}
      title="Info"
      className="reader-side-panel"
    >
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
