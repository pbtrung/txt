import type { AwsClient } from "aws4fetch";
import type { Client } from "@libsql/core/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { loadTxtMetadata } from "./metadata";
import * as r2 from "./r2";
import type { R2Config } from "./r2Config";

vi.mock("./r2", () => ({ getObject: vi.fn() }));

const r2Client = {} as AwsClient;
const r2Config: R2Config = {
  endpoint: "https://example",
  region: "auto",
  bucket: "bucket",
  readOnlyAccessKeyId: "id",
  readOnlySecretAccessKey: "secret",
};

function fakeClient(row: Record<string, unknown> | undefined): Client {
  return {
    async execute() {
      return {
        rows: row ? [row] : [],
        columns: [],
        columnTypes: [],
        rowsAffected: 0,
        lastInsertRowid: undefined,
        toJSON: () => ({}),
      };
    },
  } as unknown as Client;
}

describe("loadTxtMetadata", () => {
  afterEach(() => {
    vi.mocked(r2.getObject).mockReset();
  });

  it("returns an empty map when txt_metadata.content is null", async () => {
    const umk = new Uint8Array(64).fill(1);
    const keyBlob = await blob.encrypt(umk, new Uint8Array(64).fill(2));
    const db = fakeClient({ txt_metadata_key: keyBlob.buffer, content: null });
    const result = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);
    expect(result.size).toBe(0);
  });

  it("returns an empty map when there is no txt_metadata row at all", async () => {
    const db = fakeClient(undefined);
    const result = await loadTxtMetadata(db, 42, new Uint8Array(64), r2Client, r2Config);
    expect(result.size).toBe(0);
  });

  it("fetches content from R2 when txt_metadata.content is a wrapped path (new format)", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);

    const content = { "3": { name: "short.txt" } };
    const body = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });
    const pathBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode("some-raw-path"));
    expect(pathBlob.length).toBeLessThan(200); // must land under TXT_METADATA_LEGACY_THRESHOLD to hit this branch

    vi.mocked(r2.getObject).mockResolvedValue(body);

    const db = fakeClient({ txt_metadata_key: keyBlob.buffer, content: pathBlob.buffer });
    const result = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

    expect(r2.getObject).toHaveBeenCalledWith(r2Client, r2Config, "some-raw-path");
    expect(result.get(3)?.name).toBe("short.txt");
  });

  it("decrypts and normalizes OPF metadata, tolerating missing fields", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);

    const content = {
      "7": {
        name: "the-white-order.epub.txt",
        metadata: {
          title: "The White Order",
          creator: { text: "L. E. Modesitt, Jr.", role: "aut" },
          subject: ["Fantasy", "Military"],
          publisher: "Tor Publishing Group",
          "calibre:series": "Saga of Recluce",
          "calibre:series_index": "8",
        },
      },
      "8": {
        // No OPF sidecar was found for this one -- just a bare filename.
        name: "plain-notes.txt",
      },
    };
    const contentBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });

    const db = fakeClient({ txt_metadata_key: keyBlob.buffer, content: contentBlob.buffer });
    const result = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

    expect(result.size).toBe(2);
    expect(result.get(7)).toEqual({
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
    expect(result.get(8)).toEqual({
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

  it("keeps every metadata field verbatim in rawMetadata, including ones with no curated column", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);

    const content = {
      "9": {
        name: "some-book.epub.txt",
        metadata: {
          title: "Some Book",
          date: { text: "2020-01-01", event: "publication" },
          identifier: { text: "978-0-000-00000-0", scheme: "ISBN" },
          language: "en",
        },
      },
    };
    const contentBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });

    const db = fakeClient({ txt_metadata_key: keyBlob.buffer, content: contentBlob.buffer });
    const result = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

    expect(result.get(9)?.rawMetadata).toEqual([
      { key: "title", values: ["Some Book"] },
      { key: "date", values: ["January 1, 2020"] }, // reformatted, see the dedicated date-formatting tests below
      { key: "identifier", values: ["978-0-000-00000-0"] },
      { key: "language", values: ["en"] },
    ]);
  });

  describe("rawMetadata: date fields", () => {
    async function rawMetadataFor(metadata: Record<string, unknown>) {
      const umk = new Uint8Array(64).fill(1);
      const txtMetadataKey = new Uint8Array(64).fill(4);
      const keyBlob = await blob.encrypt(umk, txtMetadataKey);
      // Padded with an unrelated sibling entry so the encrypted+compressed
      // content blob reliably lands above TXT_METADATA_LEGACY_THRESHOLD --
      // otherwise these single-field fixtures are small enough to be
      // misread as the new wrapped-path format instead of inline JSON.
      const content = {
        "1": { name: "book.epub.txt", metadata },
        "999": { name: "padding-padding-padding-padding-padding-padding-padding.txt" },
      };
      const contentBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
        compressed: true,
      });
      const db = fakeClient({ txt_metadata_key: keyBlob.buffer, content: contentBlob.buffer });
      const result = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);
      return result.get(1)?.rawMetadata ?? [];
    }

    it("formats a date-only value (no time component at all) as just the date", async () => {
      const rawMetadata = await rawMetadataFor({ date: "2020-01-15" });
      expect(rawMetadata).toEqual([{ key: "date", values: ["January 15, 2020"] }]);
    });

    it("formats a timestamp with an all-zero time-of-day as just the date", async () => {
      const rawMetadata = await rawMetadataFor({ date: "2020-01-15T00:00:00+00:00" });
      expect(rawMetadata).toEqual([{ key: "date", values: ["January 15, 2020"] }]);
    });

    it("formats a timestamp with a real time-of-day as date and time", async () => {
      const rawMetadata = await rawMetadataFor({ date: "2020-01-15T08:23:45+00:00" });
      expect(rawMetadata).toEqual([{ key: "date", values: ["January 15, 2020, 8:23 AM"] }]);
    });

    it("renames calibre:timestamp to timestamp and formats it the same way", async () => {
      const rawMetadata = await rawMetadataFor({ "calibre:timestamp": "2019-06-01T14:05:00+00:00" });
      expect(rawMetadata).toEqual([{ key: "timestamp", values: ["June 1, 2019, 2:05 PM"] }]);
    });

    it("falls back to the raw string for a value that doesn't look like an OPF timestamp", async () => {
      const rawMetadata = await rawMetadataFor({ date: "circa 1990" });
      expect(rawMetadata).toEqual([{ key: "date", values: ["circa 1990"] }]);
    });
  });

  it("drops calibre:rating, calibre:title_sort, description, and subject from rawMetadata entirely", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);

    const content = {
      "1": {
        name: "book.epub.txt",
        metadata: {
          title: "Some Book",
          "calibre:rating": "8",
          "calibre:title_sort": "Book, Some",
          description: "A book about things.",
          subject: ["Fantasy"],
        },
      },
    };
    const contentBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });

    const db = fakeClient({ txt_metadata_key: keyBlob.buffer, content: contentBlob.buffer });
    const result = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

    expect(result.get(1)?.rawMetadata).toEqual([{ key: "title", values: ["Some Book"] }]);
  });
});
