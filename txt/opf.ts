// Calibre .opf sidecar detection and <metadata> extraction for txt.ts
// --ingest. Port of the pre-InstantDB Python design's txt/opf.py.
//
// No general XML parser dependency exists in this repo, and a Calibre OPF's
// <metadata> block is simple, flat, well-formed XML (a handful of leaf
// dc:*/meta elements, never nested) -- this is a small, tolerant,
// OPF-scoped scanner, not a general XML parser: it finds the first
// "metadata" element anywhere in the document (namespace-prefix-tolerant,
// like Python's ElementTree.iter() local-name search) and reads only that
// element's own direct children.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

function localName(qualified: string): string {
  const idx = qualified.lastIndexOf(":");
  return idx === -1 ? qualified : qualified.slice(idx + 1);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&"); // must be last -- undoes double-unescaping risk
}

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w.:-]+)\s*=\s*"([^"]*)"|([\w.:-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString))) {
    if (m[1] !== undefined) attrs[m[1]] = decodeEntities(m[2]!);
    else attrs[m[3]!] = decodeEntities(m[4]!);
  }
  return attrs;
}

function localizeAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[localName(k)] = v;
  return out;
}

function extractMetadataBlock(xml: string): string | null {
  const m = /<((?:[\w.-]+:)?metadata)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(xml);
  return m ? m[2]! : null;
}

interface DirectChild {
  tag: string;
  attrs: Record<string, string>;
  text: string;
}

// Only direct children of `xml` (the already-extracted <metadata> inner
// content) -- OPF metadata children are always leaf elements, so a matching
// close tag is assumed to be found without any nested nesting of the same
// tag name to worry about.
function directChildren(xml: string): DirectChild[] {
  const children: DirectChild[] = [];
  const tagRe = /<!--[\s\S]*?-->|<([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)(\/)?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const tag = m[1];
    if (tag === undefined) continue; // matched a comment
    const attrs = parseAttrs(m[2] ?? "");
    if (m[3] === "/") {
      children.push({ tag, attrs, text: "" });
      continue;
    }
    const searchFrom = tagRe.lastIndex;
    const closeRe = new RegExp(
      `<\\/${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`,
    );
    const closeMatch = closeRe.exec(xml.slice(searchFrom));
    if (!closeMatch) continue; // malformed/unclosed tag -- skip it
    const text = xml.slice(searchFrom, searchFrom + closeMatch.index);
    children.push({ tag, attrs, text: decodeEntities(text).trim() });
    tagRe.lastIndex = searchFrom + closeMatch.index + closeMatch[0].length;
  }
  return children;
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

// Parses <name>.opf's <metadata> into a flat dict: dc:* elements become
// {tag: text} or {tag: {text, ...attrs}} if attributed (scheme/id/role/
// file-as); <meta name=".." content=".."/> becomes {name: content};
// repeated tags collapse into a list. Returns {} if no <metadata> element
// is found.
export function parseOpfMetadata(opfPath: string): Record<string, unknown> {
  const xml = readFileSync(opfPath, "utf8");
  const metadataXml = extractMetadataBlock(xml);
  if (metadataXml === null) return {};
  const result: Record<string, unknown> = {};
  for (const child of directChildren(metadataXml)) {
    const tag = localName(child.tag);
    let key: string | null;
    let value: unknown;
    if (tag === "meta") {
      key = child.attrs.name ?? null;
      value = child.attrs.content ?? null;
    } else {
      const attrs = localizeAttrs(child.attrs);
      if (isCalibreOwn(tag, attrs)) continue;
      key = tag;
      value = elementValue(child.text, attrs);
    }
    if (key !== null) addMetadataField(result, key, value);
  }
  return result;
}
