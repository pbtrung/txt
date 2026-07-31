// Calibre/OPF book descriptions (dc:description) commonly carry HTML
// markup, unescaped back into a literal string when the ingested <name>.opf
// sidecar is parsed into txt.metadata (see docs/data_model.md's txt table)
// -- so BookInfo.description can be `<p>...</p>`, not plain text. It has to
// be sanitized before rendering: an untrusted .opf's description could
// otherwise carry a script tag, and an unsanitized dangerouslySetInnerHTML
// would run it in the reader's session. DOMPurify strips everything but a
// small, formatting-only tag allowlist appropriate for a short blurb (no
// script/style/iframe/on* handlers/javascript: URIs, regardless of the
// allowlist below -- DOMPurify enforces that unconditionally).

import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["p", "br", "b", "i", "em", "strong", "u", "a", "span", "ul", "ol", "li"];
const ALLOWED_ATTR = ["href"];

export function sanitizeDescriptionHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, { ALLOWED_TAGS, ALLOWED_ATTR });
}

/** Strips all markup down to plain text -- same sanitization guarantees as
 * sanitizeDescriptionHtml (still untrusted input), for the collapsed
 * "first 200 characters" preview, which doesn't try to preserve formatting. */
export function descriptionPlainText(dirty: string): string {
  return DOMPurify.sanitize(dirty, { ALLOWED_TAGS: [] });
}
