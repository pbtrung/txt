// Renders the requested document with epub.js.
import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { EpubRenderer } from "../../data/epubRenderer";
import { useVault } from "../../state/VaultContext";
import { useReaderDocument } from "./useReaderDocument";

export function ReaderScreen() {
  const { txtId } = useParams<{ txtId: string }>();
  const { session } = useVault();
  const { status, document, error } = useReaderDocument(session, Number(txtId));
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== "ready" || !document || !containerRef.current) return;
    const renderer = new EpubRenderer(document.epubBytes);
    renderer.renderTo(containerRef.current);
    return () => renderer.destroy();
  }, [status, document]);

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
      <h1 className="h5 border-bottom px-3 py-2 mb-0">{document!.title}</h1>
      <div ref={containerRef} className="flex-grow-1" />
    </div>
  );
}
