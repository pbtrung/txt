// Calibre/OPF book descriptions (dc:description) commonly carry HTML
// markup, XML-escaped inside the .opf and unescaped back into a literal
// string by opf.py's ElementTree parsing (see txt/opf.py, docs/data_model.md's
// txt_metadata) -- so BookInfo.description can be `<p>...</p>`, not plain
// text. It has to be sanitized before rendering: this string can come from
// a shared document (txt_shares), i.e. from someone else's ingest, not
// necessarily this account's own -- an unsanitized dangerouslySetInnerHTML
// would let a malicious .opf's description run script in the reader's
// session. DOMPurify strips everything but a small, formatting-only tag
// allowlist appropriate for a short blurb (no script/style/iframe/on*
// handlers/javascript: URIs, regardless of the allowlist below -- DOMPurify
// enforces that unconditionally).

import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["p", "br", "b", "i", "em", "strong", "u", "a", "span", "ul", "ol", "li"];
const ALLOWED_ATTR = ["href"];

export function sanitizeDescriptionHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, { ALLOWED_TAGS, ALLOWED_ATTR });
}
