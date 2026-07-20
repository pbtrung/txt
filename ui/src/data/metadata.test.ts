import type { Client } from "@libsql/core/api";
import { describe, expect, it } from "vitest";

import * as blob from "../crypto/blob";
import { loadTxtMetadata } from "./metadata";

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
  it("returns an empty map when txt_metadata.content is null", async () => {
    const umk = new Uint8Array(64).fill(1);
    const keyBlob = await blob.encrypt(umk, new Uint8Array(64).fill(2));
    const db = fakeClient({ txt_metadata_key: keyBlob.buffer, content: null });
    const result = await loadTxtMetadata(db, 42, umk);
    expect(result.size).toBe(0);
  });

  it("returns an empty map when there is no txt_metadata row at all", async () => {
    const db = fakeClient(undefined);
    const result = await loadTxtMetadata(db, 42, new Uint8Array(64));
    expect(result.size).toBe(0);
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
    const result = await loadTxtMetadata(db, 42, umk);

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
    });
  });
});
