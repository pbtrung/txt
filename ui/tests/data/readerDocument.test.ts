// @vitest-environment jsdom
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { encrypt } from "../../src/crypto/cryptoBlob";
import { loadReaderDocument } from "../../src/data/readerDocument";
import type { LibraryStore } from "../../src/data/libraryStore";
import type { R2Session } from "../../src/data/r2Session";

function fakeLibrary(
  document: Awaited<ReturnType<LibraryStore["getReaderDocument"]>>,
): LibraryStore {
  return {
    getReaderDocument: vi.fn().mockResolvedValue(document),
  } as unknown as LibraryStore;
}

function fakeStorage(objects: Record<string, Uint8Array>): R2Session {
  return {
    getDocument: vi.fn(async (key: string) => objects[key] ?? null),
  } as unknown as R2Session;
}

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function opfMetadataXml(fields: {
  authors?: string[];
  subjects?: string[];
  publisher?: string;
  description?: string;
}): string {
  const creators = (fields.authors ?? []).map((a) => `<dc:creator>${a}</dc:creator>`);
  const subjects = (fields.subjects ?? []).map((s) => `<dc:subject>${s}</dc:subject>`);
  const publisher = fields.publisher
    ? `<dc:publisher>${fields.publisher}</dc:publisher>`
    : "";
  const description = fields.description
    ? `<dc:description>${fields.description}</dc:description>`
    : "";
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>${creators.join("")}${subjects.join("")}${publisher}${description}</metadata>
</package>`;
}

async function buildFakeEpub(fields: {
  authors?: string[];
  subjects?: string[];
  publisher?: string;
  description?: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", opfMetadataXml(fields));
  return zip.generateAsync({ type: "uint8array" });
}

describe("loadReaderDocument (real crypto)", () => {
  it("fetches and decrypts a document's content under its own content key", async () => {
    const contentKey = crypto.getRandomValues(new Uint8Array(128));
    const epubBytes = await buildFakeEpub({
      authors: ["Frank Herbert"],
      subjects: ["Science Fiction", "Adventure"],
      publisher: "Ace",
      description: "A desert planet.",
    });
    const encrypted = await encrypt(epubBytes, contentKey);
    const library = fakeLibrary({
      contentKey,
      path: "dune-path",
      lastCfi: "epubcfi(/6/4!/4/2)",
      title: "Dune",
    });
    const storage = fakeStorage({ "the-db-prefix/documents/dune-path": encrypted });

    const progress: string[] = [];
    const doc = await loadReaderDocument(library, storage, "the-db-prefix", 1, (step) =>
      progress.push(`${step.step}/${step.total} ${step.label}`),
    );

    expect(progress).toEqual([
      "1/4 Reading book details",
      "2/4 Downloading text",
      "3/4 Decrypting text",
      "4/4 Reading book metadata",
    ]);
    expect(doc).not.toBeNull();
    expect(doc!.txtId).toBe(1);
    expect(doc!.lastCfi).toBe("epubcfi(/6/4!/4/2)");
    expect(doc!.title).toBe("Dune");
    expect(doc!.authors).toEqual(["Frank Herbert"]);
    expect(doc!.subjects).toEqual(["Science Fiction", "Adventure"]);
    expect(doc!.publisher).toBe("Ace");
    expect(doc!.extraMetadata).toEqual([
      { label: "Description", values: ["A desert planet."] },
    ]);
    expect(doc!.epubBytes).toEqual(epubBytes);
  });

  it("passes through an empty authors/subjects and a null publisher", async () => {
    const contentKey = crypto.getRandomValues(new Uint8Array(128));
    const epubBytes = await buildFakeEpub({});
    const encrypted = await encrypt(epubBytes, contentKey);
    const library = fakeLibrary({
      contentKey,
      path: "path",
      lastCfi: null,
      title: "untitled.epub",
    });
    const storage = fakeStorage({ "the-db-prefix/documents/path": encrypted });

    const doc = await loadReaderDocument(library, storage, "the-db-prefix", 1);

    expect(doc!.title).toBe("untitled.epub");
    expect(doc!.authors).toEqual([]);
    expect(doc!.subjects).toEqual([]);
    expect(doc!.publisher).toBeNull();
    expect(doc!.extraMetadata).toEqual([]);
  });

  it("returns null when the document doesn't exist in the library", async () => {
    const library = fakeLibrary(undefined);
    const storage = fakeStorage({});

    expect(await loadReaderDocument(library, storage, "the-db-prefix", 999)).toBeNull();
  });

  it("returns null when the R2 content object is missing", async () => {
    const library = fakeLibrary({
      contentKey: crypto.getRandomValues(new Uint8Array(128)),
      path: "path",
      lastCfi: null,
      title: "x.epub",
    });
    const storage = fakeStorage({});

    expect(await loadReaderDocument(library, storage, "the-db-prefix", 1)).toBeNull();
  });
});
