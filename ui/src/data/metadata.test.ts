import { describe, expect, it } from "vitest";

import * as blob from "../crypto/blob";
import { bytesToBase64, randomBytes } from "../crypto/bytes";
import {
  formatOpfDate,
  parseMetadataContent,
  toBookInfo,
  type OpfMetadata,
  type TxtMetadataContent,
} from "./metadata";

function content(name: string, metadata: OpfMetadata = {}): TxtMetadataContent {
  return { name, metadata };
}

describe("toBookInfo", () => {
  it("normalizes OPF metadata, tolerating missing fields", () => {
    const metadata: OpfMetadata = {
      title: "The White Order",
      creator: { text: "L. E. Modesitt, Jr.", role: "aut" },
      subject: ["Fantasy", "Military"],
      publisher: "Tor Publishing Group",
      "calibre:series": "Saga of Recluce",
      "calibre:series_index": "8",
    };

    expect(
      toBookInfo("txt-7", content("the-white-order.epub.txt", metadata)),
    ).toEqual({
      txtId: "txt-7",
      name: "the-white-order.epub.txt",
      title: "The White Order",
      author: "L. E. Modesitt, Jr.",
      subjects: ["Fantasy", "Military"],
      publisher: "Tor Publishing Group",
      description: undefined,
      series: "Saga of Recluce",
      seriesIndex: "8",
      rawMetadata: [
        { key: "title", values: ["The White Order"] },
        { key: "creator", values: ["L. E. Modesitt, Jr."] },
        { key: "publisher", values: ["Tor Publishing Group"] },
        { key: "series", values: ["Saga of Recluce"] },
        { key: "series index", values: ["8"] },
      ], // subject is omitted -- already shown as badges in the curated summary above
    });
  });

  it("falls back to name when there's no title, and tolerates an empty metadata object", () => {
    expect(toBookInfo("txt-8", content("plain-notes.txt"))).toEqual({
      txtId: "txt-8",
      name: "plain-notes.txt",
      title: "plain-notes.txt",
      author: undefined,
      subjects: [],
      publisher: undefined,
      description: undefined,
      series: undefined,
      seriesIndex: undefined,
      rawMetadata: [],
    });
  });

  it("keeps every metadata field verbatim in rawMetadata, including ones with no curated column", () => {
    const metadata: OpfMetadata = {
      title: "Some Book",
      date: { text: "2020-01-01", event: "publication" },
      identifier: { text: "978-0-000-00000-0", scheme: "ISBN" },
      language: "en",
    };
    expect(
      toBookInfo("txt-9", content("some-book.epub.txt", metadata)).rawMetadata,
    ).toEqual([
      { key: "title", values: ["Some Book"] },
      { key: "date", values: ["January 1, 2020"] },
      { key: "identifier", values: ["978-0-000-00000-0"] },
      { key: "language", values: ["en"] },
    ]);
  });

  it("drops calibre:rating, calibre:title_sort, description, and subject from rawMetadata entirely", () => {
    const metadata: OpfMetadata = {
      title: "Some Book",
      "calibre:rating": "8",
      "calibre:title_sort": "Book, Some",
      description: "A book about things.",
      subject: ["Fantasy"],
    };
    expect(
      toBookInfo("txt-1", content("book.epub.txt", metadata)).rawMetadata,
    ).toEqual([{ key: "title", values: ["Some Book"] }]);
  });
});

describe("formatOpfDate", () => {
  it("formats a date-only value (no time component at all) as just the date", () => {
    expect(formatOpfDate("2020-01-15")).toBe("January 15, 2020");
  });

  it("formats a timestamp with an all-zero time-of-day as just the date", () => {
    expect(formatOpfDate("2020-01-15T00:00:00+00:00")).toBe("January 15, 2020");
  });

  it("formats a timestamp with a real time-of-day as date and time", () => {
    expect(formatOpfDate("2020-01-15T08:23:45+00:00")).toBe(
      "January 15, 2020, 8:23 AM",
    );
  });

  it("falls back to the raw string for a value that doesn't look like an OPF timestamp", () => {
    expect(formatOpfDate("circa 1990")).toBe("circa 1990");
  });
});

describe("parseMetadataContent", () => {
  it("decrypts and JSON-parses a real txtMetadata.content blob", async () => {
    const docKey = randomBytes(128);
    const payload = { name: "doc-one.txt", metadata: { title: "Some Book" } };
    const encrypted = await blob.encrypt(
      docKey,
      new TextEncoder().encode(JSON.stringify(payload)),
      { compressed: true },
    );
    const decoded = await parseMetadataContent(
      docKey,
      bytesToBase64(encrypted),
    );
    expect(decoded).toEqual(payload);
  });

  it("defaults metadata to {} when the payload omits it", async () => {
    const docKey = randomBytes(128);
    const encrypted = await blob.encrypt(
      docKey,
      new TextEncoder().encode(JSON.stringify({ name: "plain.txt" })),
      { compressed: true },
    );
    const decoded = await parseMetadataContent(
      docKey,
      bytesToBase64(encrypted),
    );
    expect(decoded).toEqual({ name: "plain.txt", metadata: {} });
  });

  it("throws (via blob.decrypt's own AEAD check) under the wrong docKey", async () => {
    const encrypted = await blob.encrypt(
      randomBytes(128),
      new TextEncoder().encode(JSON.stringify({ name: "x" })),
      { compressed: true },
    );
    await expect(
      parseMetadataContent(randomBytes(128), bytesToBase64(encrypted)),
    ).rejects.toThrow();
  });
});
