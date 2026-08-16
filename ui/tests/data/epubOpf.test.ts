// @vitest-environment jsdom
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extraMetadataFields, parseEpubOpf } from "../../src/data/epubOpf";

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

async function buildEpub(opfXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/content.opf", opfXml);
  return zip.generateAsync({ type: "uint8array" });
}

function packageXml(metadataInner: string): string {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:opf="http://www.idpf.org/2007/opf">
  <metadata>${metadataInner}</metadata>
</package>`;
}

describe("parseEpubOpf", () => {
  it("collapses repeated tags into an array, keeps single tags plain", async () => {
    const epub = await buildEpub(
      packageXml(
        "<dc:title>Dune</dc:title>" +
          "<dc:creator>Frank Herbert</dc:creator>" +
          "<dc:subject>Science Fiction</dc:subject>" +
          "<dc:subject>Adventure</dc:subject>",
      ),
    );

    const opf = await parseEpubOpf(epub);

    expect(opf.name).toBe("OEBPS/content.opf");
    expect(opf.metadata.title).toBe("Dune");
    expect(opf.metadata.creator).toBe("Frank Herbert");
    expect(opf.metadata.subject).toEqual(["Science Fiction", "Adventure"]);
  });

  it("keeps attributes alongside text for an attributed element", async () => {
    const epub = await buildEpub(
      packageXml(
        '<dc:identifier opf:id="uid" opf:scheme="ISBN">1234567890</dc:identifier>',
      ),
    );

    const opf = await parseEpubOpf(epub);

    expect(opf.metadata.identifier).toEqual({
      text: "1234567890",
      id: "uid",
      scheme: "ISBN",
    });
  });

  it("drops Calibre's own bookkeeping identifier/contributor entries", async () => {
    const epub = await buildEpub(
      packageXml(
        '<dc:identifier opf:scheme="calibre">abc</dc:identifier>' +
          '<dc:identifier opf:scheme="uuid">def</dc:identifier>' +
          '<dc:identifier opf:scheme="ISBN">1234567890</dc:identifier>' +
          '<dc:contributor opf:role="bkp" opf:file-as="calibre">calibre</dc:contributor>',
      ),
    );

    const opf = await parseEpubOpf(epub);

    expect(opf.metadata.identifier).toEqual({
      text: "1234567890",
      scheme: "ISBN",
    });
    expect(opf.metadata.contributor).toBeUndefined();
  });

  it("reads a <meta name=.. content=..> pair by its name attribute", async () => {
    const epub = await buildEpub(
      packageXml('<meta name="calibre:series" content="Dune Saga"/>'),
    );

    const opf = await parseEpubOpf(epub);

    expect(opf.metadata["calibre:series"]).toBe("Dune Saga");
  });

  it("returns an empty metadata object when there's no <metadata> element", async () => {
    const epub = await buildEpub(
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"/>',
    );

    const opf = await parseEpubOpf(epub);

    expect(opf.metadata).toEqual({});
  });

  it("throws when the EPUB has no META-INF/container.xml", async () => {
    const zip = new JSZip();
    zip.file("OEBPS/content.opf", packageXml("<dc:title>Dune</dc:title>"));
    const epub = await zip.generateAsync({ type: "uint8array" });

    await expect(parseEpubOpf(epub)).rejects.toThrow(/container\.xml/);
  });

  it("rejects malformed container and package XML", async () => {
    const badContainer = new JSZip();
    badContainer.file("META-INF/container.xml", "<container>");
    await expect(
      parseEpubOpf(await badContainer.generateAsync({ type: "uint8array" })),
    ).rejects.toThrow(/invalid XML/);

    await expect(parseEpubOpf(await buildEpub("<package>"))).rejects.toThrow(
      /invalid XML/,
    );
  });
});

describe("extraMetadataFields", () => {
  it("labels known dc:*/Calibre fields and drops title/creator/subject/publisher", () => {
    const opf = {
      name: "content.opf",
      metadata: {
        title: "Dune",
        creator: "Frank Herbert",
        subject: ["Science Fiction"],
        publisher: "Ace",
        description: "A desert planet.",
        language: "en",
        "calibre:series": "Dune Saga",
      },
    };

    expect(extraMetadataFields(opf)).toEqual([
      { label: "Description", values: ["A desert planet."] },
      { label: "Language", values: ["en"] },
      { label: "Series", values: ["Dune Saga"] },
    ]);
  });

  it("falls back to the raw key for an unrecognized field", () => {
    const opf = { name: "content.opf", metadata: { "custom:field": "value" } };

    expect(extraMetadataFields(opf)).toEqual([
      { label: "custom:field", values: ["value"] },
    ]);
  });

  it("returns an empty list when there's nothing beyond the known fields", () => {
    const opf = { name: "content.opf", metadata: { title: "Dune" } };

    expect(extraMetadataFields(opf)).toEqual([]);
  });
});
