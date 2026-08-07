import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOpfSidecar, parseOpfMetadata } from "../txt/opf.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opf-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE_OPF = `<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier opf:scheme="calibre" id="calibre_id">123</dc:identifier>
    <dc:identifier opf:scheme="uuid" id="uuid_id">abcd-1234</dc:identifier>
    <dc:title>Sample Book &amp; Co.</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Author, Sample">Sample Author</dc:creator>
    <dc:contributor opf:role="bkp" opf:file-as="calibre">calibre (7.0)</dc:contributor>
    <dc:date>2020-01-01T00:00:00+00:00</dc:date>
    <dc:subject>Fiction</dc:subject>
    <dc:subject>Adventure</dc:subject>
    <dc:publisher>Sample Publisher</dc:publisher>
    <dc:language>eng</dc:language>
    <meta name="calibre:timestamp" content="2020-01-01T00:00:00+00:00"/>
    <meta name="calibre:title_sort" content="Sample Book"/>
  </metadata>
  <guide>
    <reference type="cover" title="Cover" href="cover.jpg"/>
  </guide>
</package>
`;

describe("findOpfSidecar", () => {
  it("finds a case-insensitive sibling .opf for a .epub.txt file", () => {
    writeFileSync(join(dir, "Book.EPUB.TXT"), "");
    writeFileSync(join(dir, "book.OPF"), "");
    expect(findOpfSidecar(join(dir, "Book.EPUB.TXT"))).toBe(
      join(dir, "book.OPF"),
    );
  });

  it("returns null for a non-.epub.txt file", () => {
    writeFileSync(join(dir, "plain.txt"), "");
    writeFileSync(join(dir, "plain.opf"), "");
    expect(findOpfSidecar(join(dir, "plain.txt"))).toBeNull();
  });

  it("returns null when no sidecar exists", () => {
    writeFileSync(join(dir, "lonely.epub.txt"), "");
    expect(findOpfSidecar(join(dir, "lonely.epub.txt"))).toBeNull();
  });
});

describe("parseOpfMetadata", () => {
  it("parses a real Calibre-shaped OPF file, matching the Python reference exactly", () => {
    const opfPath = join(dir, "book.opf");
    writeFileSync(opfPath, SAMPLE_OPF);
    expect(parseOpfMetadata(opfPath)).toEqual({
      title: "Sample Book & Co.",
      creator: {
        text: "Sample Author",
        role: "aut",
        "file-as": "Author, Sample",
      },
      date: "2020-01-01T00:00:00+00:00",
      subject: ["Fiction", "Adventure"],
      publisher: "Sample Publisher",
      language: "eng",
      "calibre:timestamp": "2020-01-01T00:00:00+00:00",
      "calibre:title_sort": "Sample Book",
    });
  });

  it("returns {} when there is no <metadata> element", () => {
    const opfPath = join(dir, "empty.opf");
    writeFileSync(opfPath, "<package><guide/></package>");
    expect(parseOpfMetadata(opfPath)).toEqual({});
  });

  it("drops Calibre's own bookkeeping identifier/contributor entries", () => {
    const opfPath = join(dir, "book.opf");
    writeFileSync(opfPath, SAMPLE_OPF);
    const result = parseOpfMetadata(opfPath);
    expect(result).not.toHaveProperty("identifier");
    expect(result).not.toHaveProperty("contributor");
  });

  it("keeps a non-Calibre identifier", () => {
    const opfPath = join(dir, "isbn.opf");
    writeFileSync(
      opfPath,
      `<package><metadata xmlns:dc="urn:dc" xmlns:opf="urn:opf">
        <dc:identifier opf:scheme="ISBN">978-0-000-00000-0</dc:identifier>
      </metadata></package>`,
    );
    expect(parseOpfMetadata(opfPath)).toEqual({
      identifier: { text: "978-0-000-00000-0", scheme: "ISBN" },
    });
  });

  // The following cover real robustness the switch to a real XML parser
  // (@xmldom/xmldom's DOMParser) was specifically for -- a hand-rolled
  // regex-based tag scanner does not reliably handle these.
  it("treats CDATA content as literal text, not nested markup", () => {
    const opfPath = join(dir, "cdata.opf");
    writeFileSync(
      opfPath,
      `<package><metadata xmlns:dc="urn:dc">
        <dc:description><![CDATA[Has <b>markup</b> & an ampersand]]></dc:description>
      </metadata></package>`,
    );
    expect(parseOpfMetadata(opfPath)).toEqual({
      description: "Has <b>markup</b> & an ampersand",
    });
  });

  it("handles an attribute value containing a literal '>'", () => {
    const opfPath = join(dir, "gt.opf");
    writeFileSync(
      opfPath,
      `<package><metadata xmlns:dc="urn:dc" xmlns:opf="urn:opf">
        <dc:identifier opf:scheme="weird>scheme">value</dc:identifier>
      </metadata></package>`,
    );
    expect(parseOpfMetadata(opfPath)).toEqual({
      identifier: { text: "value", scheme: "weird>scheme" },
    });
  });

  it("throws on malformed (not well-formed) XML instead of silently mis-parsing", () => {
    const opfPath = join(dir, "broken.opf");
    writeFileSync(
      opfPath,
      `<package><metadata xmlns:dc="urn:dc">
        <dc:title>Unclosed
      </metadata></package>`,
    );
    expect(() => parseOpfMetadata(opfPath)).toThrow();
  });
});
