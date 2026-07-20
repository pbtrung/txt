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
    const recent = { part_num: 14, created_at: 3000 };
    const older = { part_num: 8, created_at: 2000 };
    const oldest = { part_num: 3, created_at: 1000 };
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
      { id: 30, partNum: 14, createdAtMs: 3000 },
      { id: 20, partNum: 8, createdAtMs: 2000 },
      { id: 10, partNum: 3, createdAtMs: 1000 },
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

  it("inserts an encrypted bookmark for the given part", async () => {
    const execute = vi.fn().mockResolvedValue(result([]));
    const db = { execute } as unknown as Client;
    const txtKey = new Uint8Array(64).fill(8);

    await addBookmark(db, 7, 42, txtKey, 14);

    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain("INSERT INTO bookmarks");
    expect(call.args[0]).toBe(7);
    expect(call.args[1]).toBe(42);

    const decrypted = await blob.decrypt(txtKey, call.args[2] as Uint8Array, true);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    expect(parsed.part_num).toBe(14);
    expect(typeof parsed.created_at).toBe("number");
  });

  it("swallows a write failure instead of throwing", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("read-only token"));
    const db = { execute } as unknown as Client;
    await expect(addBookmark(db, 7, 42, new Uint8Array(64), 1)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
