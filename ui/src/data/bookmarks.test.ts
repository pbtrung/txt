import type { Client } from "@libsql/core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { addBookmark, listBookmarks } from "./bookmarks";

function result(rows: Record<string, unknown>[]) {
  return { rows, columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

describe("listBookmarks", () => {
  it("decrypts every bookmark row, preserving the given (most-recent-first) order", async () => {
    const txtKey = new Uint8Array(64).fill(8);
    const recent = { part_num: 14, line: 3, txt_preview: "Cerryl witnessed a white mage destroy a renegade" };
    const older = { part_num: 8, line: 1, txt_preview: "Powerful white mages killed Cerryl's father" };
    const oldest = { part_num: 3, line: 5, txt_preview: "Raised by his aunt and uncle" };
    const rows = await Promise.all(
      [
        { id: 30, payload: recent },
        { id: 20, payload: older },
        { id: 10, payload: oldest },
      ].map(async ({ id, payload }) => ({
        id,
        bookmark: (
          await blob.encrypt(txtKey, new TextEncoder().encode(JSON.stringify(payload)), { compressed: true })
        ).buffer,
      })),
    );
    const db = { execute: vi.fn().mockResolvedValue(result(rows)) } as unknown as Client;

    const bookmarks = await listBookmarks(db, 7, 42, txtKey);
    expect(bookmarks).toEqual([
      { id: 30, partNum: 14, line: 3, txtPreview: "Cerryl witnessed a white mage destroy a renegade" },
      { id: 20, partNum: 8, line: 1, txtPreview: "Powerful white mages killed Cerryl's father" },
      { id: 10, partNum: 3, line: 5, txtPreview: "Raised by his aunt and uncle" },
    ]);
  });

  it("returns an empty list when there are no bookmarks", async () => {
    const db = { execute: vi.fn().mockResolvedValue(result([])) } as unknown as Client;
    expect(await listBookmarks(db, 7, 42, new Uint8Array(64))).toEqual([]);
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

  it("inserts an encrypted bookmark for the given part/line/preview", async () => {
    const execute = vi.fn().mockResolvedValue(result([]));
    const db = { execute } as unknown as Client;
    const txtKey = new Uint8Array(64).fill(8);

    await addBookmark(db, 7, 42, txtKey, 14, 3, "Cerryl witnessed a white mage destroy a renegade");

    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain("INSERT INTO bookmarks");
    expect(call.args[0]).toBe(7);
    expect(call.args[1]).toBe(42);

    const decrypted = await blob.decrypt(txtKey, call.args[2] as Uint8Array, true);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    expect(parsed).toEqual({ part_num: 14, line: 3, txt_preview: "Cerryl witnessed a white mage destroy a renegade" });
  });

  it("swallows a write failure instead of throwing", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("read-only token"));
    const db = { execute } as unknown as Client;
    await expect(addBookmark(db, 7, 42, new Uint8Array(64), 1, 0, "preview")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
