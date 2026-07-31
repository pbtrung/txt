import { describe, expect, it } from "vitest";

import { formatOpfDate, parseMetadataBlob, toBookInfo, type OpfMetadata } from "./metadata";
import * as brotli from "../crypto/brotli";

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

    expect(toBookInfo(7, "the-white-order.epub.txt", metadata)).toEqual({
      txtId: 7,
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
    expect(toBookInfo(8, "plain-notes.txt", {})).toEqual({
      txtId: 8,
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
    expect(toBookInfo(9, "some-book.epub.txt", metadata).rawMetadata).toEqual([
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
    expect(toBookInfo(1, "book.epub.txt", metadata).rawMetadata).toEqual([
      { key: "title", values: ["Some Book"] },
    ]);
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
    expect(formatOpfDate("2020-01-15T08:23:45+00:00")).toBe("January 15, 2020, 8:23 AM");
  });

  it("falls back to the raw string for a value that doesn't look like an OPF timestamp", () => {
    expect(formatOpfDate("circa 1990")).toBe("circa 1990");
  });
});

describe("parseMetadataBlob", () => {
  it("returns {} for a null column (no OPF sidecar found at ingest time)", async () => {
    expect(await parseMetadataBlob(null)).toEqual({});
  });

  it("brotli-decompresses and JSON-parses a real metadata blob", async () => {
    const metadata = { title: "Some Book" };
    const compressed = await brotli.compress(new TextEncoder().encode(JSON.stringify(metadata)));
    expect(await parseMetadataBlob(compressed)).toEqual(metadata);
  });
});
