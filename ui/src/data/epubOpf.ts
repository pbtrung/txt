// Parses an EPUB's own internal package document (its content.opf, part of
// the EPUB spec) once the Reader already has the book's bytes in hand --
// this is what feeds the Info panel with full metadata, since txt.catalog
// (docs/data_model.md §2.1) only keeps a fixed subset. Mirrors
// txt/opf.py's parse_opf_metadata field-by-field, but reads the EPUB's own
// package document via JSZip + DOMParser instead of a Calibre sidecar
// .opf via ElementTree.
import JSZip from "jszip";
import { fieldStrings, type OpfField, type ParsedOpf } from "./opfMetadata";

const CONTAINER_PATH = "META-INF/container.xml";

// title/creator/subject/publisher already get their own dedicated fields
// on ReaderDocument (readerDocument.ts); everything else the OPF carries
// (description, language, date, Calibre's own series/rating meta, ...) is
// shown generically in the Info panel via extraMetadataFields below.
const KNOWN_FIELDS = new Set(["title", "creator", "subject", "publisher"]);

const FIELD_LABELS: Record<string, string> = {
  date: "Date",
  description: "Description",
  language: "Language",
  rights: "Rights",
  identifier: "Identifier",
  contributor: "Contributor",
  source: "Source",
  type: "Type",
  format: "Format",
  relation: "Relation",
  coverage: "Coverage",
  "calibre:series": "Series",
  "calibre:series_index": "Series index",
  "calibre:rating": "Rating",
  "calibre:title_sort": "Sort title",
};

// Calibre's own bookkeeping, not real book metadata: its internal library id
// and uuid (dc:identifier opf:scheme="calibre"/"uuid") and its self-authored
// "book producer" contributor entry (opf:role="bkp" opf:file-as="calibre").
const IGNORED_IDENTIFIER_SCHEMES = new Set(["calibre", "uuid"]);

function findByLocalName(root: Element, name: string): Element | null {
  for (const el of Array.from(root.getElementsByTagName("*"))) {
    if (el.localName === name) return el;
  }
  return null;
}

function localAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) attrs[attr.localName] = attr.value;
  return attrs;
}

function isCalibreOwn(tag: string, attrs: Record<string, string>): boolean {
  if (tag === "identifier") {
    return IGNORED_IDENTIFIER_SCHEMES.has(attrs["scheme"]?.toLowerCase() ?? "");
  }
  if (tag === "contributor") {
    return (
      attrs["role"]?.toLowerCase() === "bkp" &&
      attrs["file-as"]?.toLowerCase() === "calibre"
    );
  }
  return false;
}

function elementValue(text: string, attrs: Record<string, string>): OpfField {
  return Object.keys(attrs).length > 0 ? { text, ...attrs } : text;
}

function addMetadataField(
  result: Record<string, OpfField | OpfField[]>,
  key: string,
  value: OpfField,
): void {
  const existing = result[key];
  if (existing === undefined) {
    result[key] = value;
  } else {
    result[key] = (Array.isArray(existing) ? existing : [existing]).concat(value);
  }
}

function metadataDict(metadataEl: Element): Record<string, OpfField | OpfField[]> {
  const result: Record<string, OpfField | OpfField[]> = {};
  for (const child of Array.from(metadataEl.children)) {
    const tag = child.localName;
    let key: string | null;
    let value: OpfField;
    if (tag === "meta") {
      key = child.getAttribute("name");
      value = child.getAttribute("content") ?? "";
    } else {
      const attrs = localAttrs(child);
      if (isCalibreOwn(tag, attrs)) continue;
      key = tag;
      value = elementValue((child.textContent ?? "").trim(), attrs);
    }
    if (key !== null) addMetadataField(result, key, value);
  }
  return result;
}

async function readZipXml(zip: JSZip, path: string): Promise<Document> {
  const xml = await zip.file(path)?.async("string");
  if (xml === undefined) throw new Error(`${path} not found in EPUB`);
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror")) {
    throw new Error(`${path} contains invalid XML`);
  }
  return document;
}

async function rootfilePath(zip: JSZip): Promise<string> {
  const container = await readZipXml(zip, CONTAINER_PATH);
  const rootfile = findByLocalName(container.documentElement, "rootfile");
  const fullPath = rootfile?.getAttribute("full-path");
  if (!fullPath) throw new Error("no <rootfile full-path> found in container.xml");
  return fullPath;
}

export async function parseEpubOpf(epubBytes: Uint8Array): Promise<ParsedOpf> {
  const zip = await JSZip.loadAsync(epubBytes);
  const opfPath = await rootfilePath(zip);
  const opf = await readZipXml(zip, opfPath);
  const metadataEl = findByLocalName(opf.documentElement, "metadata");
  return { metadata: metadataEl ? metadataDict(metadataEl) : {} };
}

export interface MetadataField {
  label: string;
  values: string[];
}

export function extraMetadataFields(opf: ParsedOpf): MetadataField[] {
  return Object.entries(opf.metadata)
    .filter(([key]) => !KNOWN_FIELDS.has(key))
    .map(([key, value]) => ({
      label: FIELD_LABELS[key] ?? key,
      values: fieldStrings(value),
    }))
    .filter((field) => field.values.length > 0);
}
