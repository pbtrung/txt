// Calibre .opf sidecar detection and <metadata> extraction for txt.ts
// --ingest. Port of the pre-InstantDB Python design's txt/opf.py.
//
// Uses @xmldom/xmldom's DOMParser -- a real, spec-following XML parser --
// rather than a hand-rolled tag scanner: OPF files aren't only ever
// produced by Calibre in practice, and a regex-based scanner doesn't
// reliably handle CDATA, comments, quoting edge cases, or malformed input
// the way a real parser does (it either parses correctly or throws, same
// as Python's xml.etree.ElementTree that opf.py originally used).
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DOMParser,
  onErrorStopParsing,
  type Document,
  type Element,
} from "@xmldom/xmldom";

const EPUB_TXT_SUFFIX = ".epub.txt";

// The sibling <name>.opf (any case) for a <name>.epub.txt (any case) file,
// or null if filePath isn't a .epub.txt file or has no such sibling.
export function findOpfSidecar(filePath: string): string | null {
  const name = basename(filePath);
  if (!name.toLowerCase().endsWith(EPUB_TXT_SUFFIX)) return null;
  const base = name.slice(0, name.length - EPUB_TXT_SUFFIX.length);
  const target = `${base}.opf`.toLowerCase();
  const dir = dirname(filePath);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === target) {
      return join(dir, entry.name);
    }
  }
  return null;
}

// Calibre's own bookkeeping, not real book metadata: its internal library id
// and uuid (dc:identifier opf:scheme="calibre"/"uuid") and its self-authored
// "book producer" contributor entry (opf:role="bkp" opf:file-as="calibre").
const IGNORED_IDENTIFIER_SCHEMES = new Set(["calibre", "uuid"]);

function isCalibreOwn(tag: string, attrs: Record<string, string>): boolean {
  if (tag === "identifier") {
    return IGNORED_IDENTIFIER_SCHEMES.has(attrs.scheme ?? "");
  }
  if (tag === "contributor") {
    return attrs.role === "bkp" && attrs["file-as"] === "calibre";
  }
  return false;
}

function elementValue(text: string, attrs: Record<string, string>): unknown {
  return Object.keys(attrs).length > 0 ? { text, ...attrs } : text;
}

function addMetadataField(
  result: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!(key in result)) {
    result[key] = value;
    return;
  }
  const existing = result[key];
  if (!Array.isArray(existing)) result[key] = [existing];
  (result[key] as unknown[]).push(value);
}

// child's own attributes, keyed by local name (namespace prefix stripped,
// e.g. opf:scheme -> scheme) -- matches Python's ElementTree-based
// _local_attrs, which strips the same Clark-notation namespace off each
// attribute key.
function localizeAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i]!;
    attrs[attr.localName ?? attr.name] = attr.value;
  }
  return attrs;
}

// onErrorStopParsing throws on an "error"-level report (a "fatalError"
// already always throws regardless of onError); "warning"-level reports are
// silently ignored rather than going to console.error, same as this parser
// otherwise does when no onError is given at all.
function parseOpfDocument(xml: string): Document {
  return new DOMParser({ onError: onErrorStopParsing }).parseFromString(
    xml,
    "text/xml",
  );
}

// Parses <name>.opf's <metadata> into a flat dict: dc:* elements become
// {tag: text} or {tag: {text, ...attrs}} if attributed (scheme/id/role/
// file-as); <meta name=".." content=".."/> becomes {name: content};
// repeated tags collapse into a list. Returns {} if no <metadata> element
// is found. Throws if the file isn't well-formed XML.
export function parseOpfMetadata(opfPath: string): Record<string, unknown> {
  const xml = readFileSync(opfPath, "utf8");
  const doc = parseOpfDocument(xml);
  // "*" for namespaceURI matches any namespace -- Calibre OPF declares
  // <metadata> with no prefix under the OPF default namespace, but this
  // stays tolerant of a prefixed <opf:metadata> too, same as Python's own
  // local-name-only search via ElementTree.iter().
  const metadataEl = doc.getElementsByTagNameNS("*", "metadata")[0];
  if (!metadataEl) return {};

  const result: Record<string, unknown> = {};
  for (let i = 0; i < metadataEl.childNodes.length; i++) {
    const child = metadataEl.childNodes[i]!;
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const el = child as unknown as Element;
    const tag = el.localName ?? el.tagName;
    let key: string | null;
    let value: unknown;
    if (tag === "meta") {
      key = el.getAttribute("name");
      value = el.getAttribute("content");
    } else {
      const attrs = localizeAttrs(el);
      if (isCalibreOwn(tag, attrs)) continue;
      key = tag;
      value = elementValue((el.textContent ?? "").trim(), attrs);
    }
    if (key !== null) addMetadataField(result, key, value);
  }
  return result;
}
