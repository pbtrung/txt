import type { Client } from "@libsql/core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { BOOKMARK_LIMIT } from "../crypto/constants";
import { addBookmark, loadOrInitBookmarks, removeBookmark, type BookmarksMap } from "./bookmarks";

function emptyResult() {
  return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

function rowResult(row: Record<string, unknown>) {
  return { ...emptyResult(), rows: [row] };
}

describe("loadOrInitBookmarks", () => {
  it("creates a new row (encrypted empty map) when none exists", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const umk = new Uint8Array(64).fill(1);

    const { bookmarkKey, bookmarksMap } = await loadOrInitBookmarks(db, 42, umk);

    expect(bookmarkKey.length).toBe(64);
    expect(bookmarksMap.size).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
    const insertCall = execute.mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(insertCall.sql).toContain("INSERT INTO bookmarks");
    expect(insertCall.args[0]).toBe(42);

    const unwrappedKey = await blob.decrypt(umk, insertCall.args[1] as Uint8Array);
    expect(Array.from(unwrappedKey)).toEqual(Array.from(bookmarkKey));
    const decrypted = await blob.decrypt(bookmarkKey, insertCall.args[2] as Uint8Array, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({});
  });

  it("decrypts and parses an existing row, keyed by txt_id", async () => {
    const umk = new Uint8Array(64).fill(1);
    const bookmarkKey = new Uint8Array(64).fill(2);
    const keyBlob = await blob.encrypt(umk, bookmarkKey);
    const json = {
      "7": [{ part_num: 14, line: 3, txt_preview: "Cerryl witnessed a white mage", created_at: 200 }],
    };
    const bookmarkBlob = await blob.encrypt(bookmarkKey, new TextEncoder().encode(JSON.stringify(json)), {
      compressed: true,
    });
    const execute = vi
      .fn()
      .mockResolvedValue(rowResult({ bookmark_key: keyBlob.buffer, bookmark: bookmarkBlob.buffer }));
    const db = { execute } as unknown as Client;

    const result = await loadOrInitBookmarks(db, 42, umk);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(Array.from(result.bookmarkKey)).toEqual(Array.from(bookmarkKey));
    expect(result.bookmarksMap).toEqual(
      new Map([[7, [{ partNum: 14, line: 3, txtPreview: "Cerryl witnessed a white mage", createdAt: 200 }]]]),
    );
  });
});

describe("addBookmark", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("appends an encrypted bookmark for the given part/line/preview and persists via UPDATE", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const bookmarkKey = new Uint8Array(64).fill(8);

    const next = await addBookmark(db, 42, bookmarkKey, new Map(), 7, 14, 3, "Cerryl witnessed a white mage");

    expect(next.get(7)).toHaveLength(1);
    expect(next.get(7)?.[0]).toMatchObject({ partNum: 14, line: 3, txtPreview: "Cerryl witnessed a white mage" });
    expect(typeof next.get(7)?.[0].createdAt).toBe("number");

    const call = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain("UPDATE bookmarks SET bookmark");
    expect(call.args[1]).toBe(42);
    const decrypted = await blob.decrypt(bookmarkKey, call.args[0] as Uint8Array, true);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    expect(parsed["7"]).toHaveLength(1);
    expect(parsed["7"][0]).toMatchObject({ part_num: 14, line: 3, txt_preview: "Cerryl witnessed a white mage" });
  });

  it("evicts the oldest-created_at bookmark for that txt_id once over BOOKMARK_LIMIT", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const bookmarkKey = new Uint8Array(64).fill(8);

    const currentMap: BookmarksMap = new Map([
      [
        7,
        Array.from({ length: BOOKMARK_LIMIT }, (_, i) => ({
          partNum: 1,
          line: i,
          txtPreview: `line ${i}`,
          createdAt: 1000 + i,
        })),
      ],
    ]);

    const next = await addBookmark(db, 42, bookmarkKey, currentMap, 7, 1, 999, "newest");

    const list = next.get(7) ?? [];
    expect(list).toHaveLength(BOOKMARK_LIMIT);
    expect(list.some((b) => b.createdAt === 1000)).toBe(false); // oldest evicted
    expect(list.some((b) => b.txtPreview === "newest")).toBe(true);
  });

  it("swallows a write failure instead of throwing", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("read-only token"));
    const db = { execute } as unknown as Client;
    const next = await addBookmark(db, 42, new Uint8Array(64), new Map(), 7, 1, 0, "preview");
    expect(next.get(7)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("removeBookmark", () => {
  it("removes the matching (txtId, createdAt) entry and persists", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const bookmarkKey = new Uint8Array(64).fill(8);
    const currentMap: BookmarksMap = new Map([
      [
        7,
        [
          { partNum: 14, line: 3, txtPreview: "a", createdAt: 100 },
          { partNum: 8, line: 1, txtPreview: "b", createdAt: 200 },
        ],
      ],
    ]);

    const next = await removeBookmark(db, 42, bookmarkKey, currentMap, 7, 100);

    expect(next.get(7)).toEqual([{ partNum: 8, line: 1, txtPreview: "b", createdAt: 200 }]);
  });

  it("drops the txt_id key entirely once its list is empty", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const bookmarkKey = new Uint8Array(64).fill(8);
    const currentMap: BookmarksMap = new Map([[7, [{ partNum: 14, line: 3, txtPreview: "a", createdAt: 100 }]]]);

    const next = await removeBookmark(db, 42, bookmarkKey, currentMap, 7, 100);

    expect(next.has(7)).toBe(false);
    const call = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    const decrypted = await blob.decrypt(bookmarkKey, call.args[0] as Uint8Array, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({});
  });
});
