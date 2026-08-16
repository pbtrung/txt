import { useState } from "react";
import { OffcanvasPanel } from "../../components/OffcanvasPanel";
import type { ReaderDocument } from "../../data/readerDocument";
import { sanitizeHtml, stripHtmlToText } from "../../data/sanitizeHtml";

const DESCRIPTION_PREVIEW_LENGTH = 300;

export function ReaderInfoPanel({
  open,
  onClose,
  document,
}: {
  open: boolean;
  onClose: () => void;
  document: ReaderDocument;
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
      <MetadataList document={document} />
    </OffcanvasPanel>
  );
}

function MetadataList({ document }: { document: ReaderDocument }) {
  return (
    <dl className="small mb-0">
      {document.publisher && (
        <MetadataGroup label="Publisher" value={document.publisher} />
      )}
      {document.subjects.length > 0 && (
        <MetadataGroup label="Subjects" value={document.subjects.join(", ")} />
      )}
      {document.extraMetadata.map((field, index) => (
        <MetadataGroup
          key={`${field.label}-${index}`}
          label={field.label}
          value={field.values.join(", ")}
          html={field.label === "Description"}
        />
      ))}
    </dl>
  );
}

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

function TruncatedHtml({ html }: { html: string }) {
  const [expanded, setExpanded] = useState(false);
  const plainText = stripHtmlToText(html);
  if (plainText.length <= DESCRIPTION_PREVIEW_LENGTH) {
    return <SanitizedHtml html={html} />;
  }
  return expanded ? (
    <>
      <SanitizedHtml html={html} />{" "}
      <ToggleDescription expanded onClick={() => setExpanded(false)} />
    </>
  ) : (
    <>
      {plainText.slice(0, DESCRIPTION_PREVIEW_LENGTH)}…{" "}
      <ToggleDescription expanded={false} onClick={() => setExpanded(true)} />
    </>
  );
}

function SanitizedHtml({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}

function ToggleDescription({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-link btn-sm p-0 align-baseline"
      onClick={onClick}
    >
      {expanded ? "Show less" : "Show more"}
    </button>
  );
}
