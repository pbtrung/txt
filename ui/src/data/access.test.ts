import type { Client } from "@libsql/core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { getReadPosition, setReadPosition } from "./access";

function emptyResult() {
  return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

describe("getReadPosition", () => {
  it("returns null when there is no txt_access row", async () => {
    const db = { execute: vi.fn().mockResolvedValue(emptyResult()) } as unknown as Client;
    expect(await getReadPosition(db, 7, 42, new Uint8Array(64))).toBeNull();
  });

  it("decrypts and parses an existing read position", async () => {
    const txtKey = new Uint8Array(64).fill(6);
    const payload = { last_part_num: 14, last_accessed: 1_700_000_000_000 };
    const accessBlob = await blob.encrypt(txtKey, new TextEncoder().encode(JSON.stringify(payload)), {
      compressed: true,
    });
    const db = {
      execute: vi.fn().mockResolvedValue({ ...emptyResult(), rows: [{ access: accessBlob.buffer }] }),
    } as unknown as Client;
    const result = await getReadPosition(db, 7, 42, txtKey);
    expect(result).toEqual({ lastPartNum: 14, lastAccessedMs: 1_700_000_000_000 });
  });
});

describe("setReadPosition", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("writes an encrypted, compressed blob via upsert", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const txtKey = new Uint8Array(64).fill(6);

    await setReadPosition(db, 7, 42, txtKey, { lastPartNum: 3, lastAccessedMs: 123 });

    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain("ON CONFLICT (txt_id, user_id) DO UPDATE");
    expect(call.args[0]).toBe(7);
    expect(call.args[1]).toBe(42);

    const written = call.args[2] as Uint8Array;
    const decrypted = await blob.decrypt(txtKey, written, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({ last_part_num: 3, last_accessed: 123 });
  });

  it("swallows a write failure instead of throwing (best-effort, e.g. a read-only token)", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("read-only token"));
    const db = { execute } as unknown as Client;

    await expect(
      setReadPosition(db, 7, 42, new Uint8Array(64), { lastPartNum: 1, lastAccessedMs: 1 }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
