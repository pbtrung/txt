// An EPUB's own dc:description commonly carries rich HTML markup (Calibre
// writes it that way), not plain text -- but it's still untrusted content
// from a book file this account chose to ingest, rendered directly into
// this app's own page (not sandboxed in an iframe the way the book's own
// content is via epub.js). sanitizeHtml() strips scripts/event handlers/
// dangerous URIs via DOMPurify before anything is handed to
// dangerouslySetInnerHTML; stripHtmlToText() gives a plain-text version
// for truncation previews, where slicing raw HTML by character count
// would risk cutting a tag in half.
import DOMPurify from "dompurify";

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

export function stripHtmlToText(html: string): string {
  const safe = sanitizeHtml(html);
  return new DOMParser().parseFromString(safe, "text/html").body.textContent ?? "";
}
