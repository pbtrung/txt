import type { AwsClient } from "aws4fetch";
import type { Client } from "@libsql/core/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { loadTxtMetadata, removeTxtMetadataEntry, saveBookMetadata, upsertTxtMetadataEntry } from "./metadata";
import * as r2 from "./r2";
import type { R2Config } from "./r2Config";

vi.mock("./r2", () => ({ getObject: vi.fn(), putObject: vi.fn() }));

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
    const { metadataById: result } = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);
    expect(result.size).toBe(0);
  });

  it("returns an empty map when there is no txt_metadata row at all", async () => {
    const db = fakeClient(undefined);
    const { metadataById: result } = await loadTxtMetadata(db, 42, new Uint8Array(64), r2Client, r2Config);
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
    const { metadataById: result } = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

    expect(r2.getObject).toHaveBeenCalledWith(r2Client, r2Config, "some-raw-path");
    expect(result.get(3)?.name).toBe("short.txt");
  });

  it("tolerates an R2 body stored uncompressed (at least one already-deployed account has one)", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);

    const content = { "5": { name: "uncompressed-body.txt" } };
    // No compressed:true here -- simulates an R2 object that was never
    // brotli-compressed, unlike what _write_txt_metadata_content produces.
    const body = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)));
    const pathBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode("another-raw-path"));

    vi.mocked(r2.getObject).mockResolvedValue(body);

    const db = fakeClient({ txt_metadata_key: keyBlob.buffer, content: pathBlob.buffer });
    const { metadataById: result } = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

    expect(result.get(5)?.name).toBe("uncompressed-body.txt");
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
    const { metadataById: result } = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

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
    const { metadataById: result } = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

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
      const { metadataById: result } = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);
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
    const { metadataById: result } = await loadTxtMetadata(db, 42, umk, r2Client, r2Config);

    expect(result.get(1)?.rawMetadata).toEqual([{ key: "title", values: ["Some Book"] }]);
  });
});

function fakeClientWithCapture(selectRow: Record<string, unknown> | undefined) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const emptyResult = {
    rows: [],
    columns: [],
    columnTypes: [],
    rowsAffected: 0,
    lastInsertRowid: undefined,
    toJSON: () => ({}),
  };
  const db = {
    async execute({ sql, args }: { sql: string; args?: unknown[] }) {
      calls.push({ sql, args: args ?? [] });
      if (sql.startsWith("SELECT")) {
        return { ...emptyResult, rows: selectRow ? [selectRow] : [] };
      }
      return emptyResult;
    },
  } as unknown as Client;
  return { db, calls };
}

describe("saveBookMetadata", () => {
  afterEach(() => {
    vi.mocked(r2.getObject).mockReset();
    vi.mocked(r2.putObject).mockReset();
  });

  it("reuses the existing R2 path in place, overwriting the curated fields and preserving name/other fields", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);
    const content = {
      "7": { name: "book.txt", metadata: { title: "Old Title", creator: "Old Author", "calibre:series": "Saga" } },
    };
    const existingBody = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });
    const pathBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode("existing-path"));
    vi.mocked(r2.getObject).mockResolvedValue(existingBody);
    let putBody: Uint8Array | null = null;
    vi.mocked(r2.putObject).mockImplementation(async (_client, _config, _key, body) => {
      putBody = body;
    });

    const { db, calls } = fakeClientWithCapture({ txt_metadata_key: keyBlob.buffer, content: pathBlob.buffer });

    const returned = await saveBookMetadata(db, 42, umk, r2Client, r2Config, 7, {
      title: "New Title",
      author: undefined,
      publisher: "Pub",
      subjects: ["A", "B"],
      description: "Desc",
    });

    expect(r2.putObject).toHaveBeenCalledWith(r2Client, r2Config, "existing-path", expect.anything());
    expect(calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);

    // The returned BookInfo reflects the same edits just persisted --
    // callers (VaultContext's updateBookMetadata) rely on this instead of
    // re-fetching+re-decrypting the whole txt_metadata object a second
    // time just to read one entry back.
    expect(returned.info).toEqual(
      expect.objectContaining({
        txtId: 7,
        title: "New Title",
        author: undefined,
        publisher: "Pub",
        subjects: ["A", "B"],
        description: "Desc",
        series: "Saga",
      }),
    );

    // The returned RawMetadataState reflects the same write too -- callers
    // (VaultContext) cache this so the *next* edit can skip re-fetching
    // entirely, not just avoid a second fetch within the same call.
    expect(returned.state.rawPath).toBe("existing-path");
    expect(returned.state.content["7"]).toEqual({
      name: "book.txt",
      metadata: {
        title: "New Title",
        publisher: "Pub",
        subject: ["A", "B"],
        description: "Desc",
        "calibre:series": "Saga",
      },
    });

    const decrypted = await blob.decrypt(txtMetadataKey, putBody!, true);
    const nextContent = JSON.parse(new TextDecoder().decode(decrypted));
    expect(nextContent["7"]).toEqual({
      name: "book.txt",
      metadata: {
        title: "New Title",
        publisher: "Pub",
        subject: ["A", "B"],
        description: "Desc",
        "calibre:series": "Saga",
      },
    });
  });

  it("establishes a fresh R2 path (migrating off the legacy inline format) and updates the DB pointer", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);
    const content = {
      "7": { name: "book.txt", metadata: { title: "Old Title" } },
      "999": { name: "padding-padding-padding-padding-padding-padding-padding.txt" },
    };
    const inlineBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });
    expect(inlineBlob.length).toBeGreaterThanOrEqual(200); // must land at/above TXT_METADATA_LEGACY_THRESHOLD

    let putBody: Uint8Array | null = null;
    vi.mocked(r2.putObject).mockImplementation(async (_client, _config, _key, body) => {
      putBody = body;
    });
    const { db, calls } = fakeClientWithCapture({ txt_metadata_key: keyBlob.buffer, content: inlineBlob.buffer });

    await saveBookMetadata(db, 42, umk, r2Client, r2Config, 7, {
      title: "New Title",
      subjects: [],
    });

    expect(r2.putObject).toHaveBeenCalledTimes(1);
    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[1]).toBe(42);
    const decrypted = await blob.decrypt(txtMetadataKey, putBody!, true);
    const nextContent = JSON.parse(new TextDecoder().decode(decrypted));
    expect(nextContent["7"]).toEqual({ name: "book.txt", metadata: { title: "New Title" } });
    expect(nextContent["999"]).toEqual(content["999"]);
  });

  it("throws when there is no txt_metadata row at all", async () => {
    const { db } = fakeClientWithCapture(undefined);
    await expect(saveBookMetadata(db, 42, new Uint8Array(64), r2Client, r2Config, 7, { subjects: [] })).rejects.toThrow(
      "no txt_metadata row",
    );
  });

  it("throws when there is no entry for txtId", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);
    const { db } = fakeClientWithCapture({ txt_metadata_key: keyBlob.buffer, content: null });
    await expect(saveBookMetadata(db, 42, umk, r2Client, r2Config, 7, { subjects: [] })).rejects.toThrow(
      "no txt_metadata entry for txt_id=7",
    );
  });

  it("skips re-fetching entirely when a cachedState is given -- the actual point of caching it", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const cachedState = {
      txtMetadataKey,
      content: { "7": { name: "book.txt", metadata: { title: "Old Title" } } },
      rawPath: "cached-path",
    };
    const execute = vi.fn();
    const db = { execute } as unknown as Client;
    const progressLabels: string[] = [];

    const { info, state } = await saveBookMetadata(
      db,
      42,
      umk,
      r2Client,
      r2Config,
      7,
      { title: "New Title", subjects: [] },
      (label) => progressLabels.push(label),
      cachedState,
    );

    expect(execute).not.toHaveBeenCalled(); // no DB read at all -- cachedState skipped it
    expect(r2.getObject).not.toHaveBeenCalled();
    expect(progressLabels).toEqual(["Uploading changes…"]); // no "Reading current metadata…" phase
    expect(info.title).toBe("New Title");
    expect(r2.putObject).toHaveBeenCalledWith(r2Client, r2Config, "cached-path", expect.anything());
    expect(state.rawPath).toBe("cached-path");
  });
});

describe("removeTxtMetadataEntry", () => {
  afterEach(() => {
    vi.mocked(r2.getObject).mockReset();
    vi.mocked(r2.putObject).mockReset();
  });

  it("removes the entry and reuses the existing path in place", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);
    const content = { "7": { name: "book.txt" }, "8": { name: "other.txt" } };
    const existingBody = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });
    const pathBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode("existing-path"));
    vi.mocked(r2.getObject).mockResolvedValue(existingBody);
    let putBody: Uint8Array | null = null;
    vi.mocked(r2.putObject).mockImplementation(async (_client, _config, _key, body) => {
      putBody = body;
    });
    const { db } = fakeClientWithCapture({ txt_metadata_key: keyBlob.buffer, content: pathBlob.buffer });

    await removeTxtMetadataEntry(db, 42, umk, r2Client, r2Config, 7);

    const decrypted = await blob.decrypt(txtMetadataKey, putBody!, true);
    const nextContent = JSON.parse(new TextDecoder().decode(decrypted));
    expect(nextContent).toEqual({ "8": { name: "other.txt" } });
  });

  it("is a no-op when there is no txt_metadata row", async () => {
    const { db } = fakeClientWithCapture(undefined);
    await removeTxtMetadataEntry(db, 42, new Uint8Array(64), r2Client, r2Config, 7);
    expect(r2.putObject).not.toHaveBeenCalled();
  });

  it("is a no-op when the entry doesn't exist", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);
    const { db } = fakeClientWithCapture({ txt_metadata_key: keyBlob.buffer, content: null });

    await removeTxtMetadataEntry(db, 42, umk, r2Client, r2Config, 7);

    expect(r2.putObject).not.toHaveBeenCalled();
  });

  it("skips re-fetching entirely when a cachedState is given", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const cachedState = {
      txtMetadataKey,
      content: { "7": { name: "book.txt" }, "8": { name: "other.txt" } },
      rawPath: "cached-path",
    };
    const execute = vi.fn();
    const db = { execute } as unknown as Client;
    const progressLabels: string[] = [];

    const state = await removeTxtMetadataEntry(
      db,
      42,
      umk,
      r2Client,
      r2Config,
      7,
      (label) => progressLabels.push(label),
      cachedState,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(r2.getObject).not.toHaveBeenCalled();
    expect(progressLabels).toEqual(["Uploading changes…"]);
    expect(state?.content).toEqual({ "8": { name: "other.txt" } });
  });
});

describe("upsertTxtMetadataEntry", () => {
  afterEach(() => {
    vi.mocked(r2.getObject).mockReset();
    vi.mocked(r2.putObject).mockReset();
  });

  it("creates a fresh entry (and R2 path) when there's no content yet -- e.g. a share recipient's first grant", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);
    let putBody: Uint8Array | null = null;
    vi.mocked(r2.putObject).mockImplementation(async (_client, _config, _key, body) => {
      putBody = body;
    });
    const { db, calls } = fakeClientWithCapture({ txt_metadata_key: keyBlob.buffer, content: null });

    const state = await upsertTxtMetadataEntry(db, 42, umk, r2Client, r2Config, 7, { name: "shared-book.txt" });

    expect(r2.putObject).toHaveBeenCalledTimes(1);
    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE"));
    expect(updateCall?.args[1]).toBe(42);
    const decrypted = await blob.decrypt(txtMetadataKey, putBody!, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({ "7": { name: "shared-book.txt" } });
    expect(state.content["7"]).toEqual({ name: "shared-book.txt" });
  });

  it("overwrites an existing entry verbatim, reusing the existing path in place", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const keyBlob = await blob.encrypt(umk, txtMetadataKey);
    const content = { "7": { name: "book.txt", metadata: { title: "Old Title" } }, "8": { name: "other.txt" } };
    const existingBody = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
      compressed: true,
    });
    const pathBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode("existing-path"));
    vi.mocked(r2.getObject).mockResolvedValue(existingBody);
    let putBody: Uint8Array | null = null;
    vi.mocked(r2.putObject).mockImplementation(async (_client, _config, _key, body) => {
      putBody = body;
    });
    const { db, calls } = fakeClientWithCapture({ txt_metadata_key: keyBlob.buffer, content: pathBlob.buffer });

    const state = await upsertTxtMetadataEntry(db, 42, umk, r2Client, r2Config, 7, { name: "new-name.txt" });

    expect(r2.putObject).toHaveBeenCalledWith(r2Client, r2Config, "existing-path", expect.anything());
    expect(calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
    const decrypted = await blob.decrypt(txtMetadataKey, putBody!, true);
    const nextContent = JSON.parse(new TextDecoder().decode(decrypted));
    expect(nextContent).toEqual({ "7": { name: "new-name.txt" }, "8": { name: "other.txt" } });
    expect(state.content["7"]).toEqual({ name: "new-name.txt" });
  });

  it("throws when there is no txt_metadata row at all", async () => {
    const { db } = fakeClientWithCapture(undefined);
    await expect(
      upsertTxtMetadataEntry(db, 42, new Uint8Array(64), r2Client, r2Config, 7, { name: "x.txt" }),
    ).rejects.toThrow("no txt_metadata row");
  });

  it("skips re-fetching entirely when a cachedState is given", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtMetadataKey = new Uint8Array(64).fill(4);
    const cachedState = { txtMetadataKey, content: { "8": { name: "other.txt" } }, rawPath: "cached-path" };
    const execute = vi.fn();
    const db = { execute } as unknown as Client;
    const progressLabels: string[] = [];

    const state = await upsertTxtMetadataEntry(
      db,
      42,
      umk,
      r2Client,
      r2Config,
      7,
      { name: "shared-book.txt" },
      (label) => progressLabels.push(label),
      cachedState,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(r2.getObject).not.toHaveBeenCalled();
    expect(progressLabels).toEqual(["Uploading changes…"]);
    expect(state.content).toEqual({ "7": { name: "shared-book.txt" }, "8": { name: "other.txt" } });
  });
});
