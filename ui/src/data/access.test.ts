import type { Client } from "@libsql/core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { TXT_ACCESS_LIMIT } from "../crypto/constants";
import { loadOrInitAccess, removeAccessEntry, setReadPosition, type AccessMap } from "./access";

function emptyResult() {
  return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

function rowResult(row: Record<string, unknown>) {
  return { ...emptyResult(), rows: [row] };
}

describe("loadOrInitAccess", () => {
  it("creates a new row (encrypted empty map) when none exists", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const umk = new Uint8Array(64).fill(1);

    const { txtAccessKey, accessMap } = await loadOrInitAccess(db, 42, umk);

    expect(txtAccessKey.length).toBe(64);
    expect(accessMap.size).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
    const insertCall = execute.mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(insertCall.sql).toContain("INSERT INTO txt_access");
    expect(insertCall.args[0]).toBe(42);

    const unwrappedKey = await blob.decrypt(umk, insertCall.args[1] as Uint8Array);
    expect(Array.from(unwrappedKey)).toEqual(Array.from(txtAccessKey));
    const decrypted = await blob.decrypt(txtAccessKey, insertCall.args[2] as Uint8Array, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({});
  });

  it("decrypts and parses an existing row, keyed by txt_id", async () => {
    const umk = new Uint8Array(64).fill(1);
    const txtAccessKey = new Uint8Array(64).fill(2);
    const keyBlob = await blob.encrypt(umk, txtAccessKey);
    const json = {
      "7": { last_part_num: 14, last_accessed: 1_700_000_000_000 },
      "12": { last_part_num: 2, last_accessed: 1_700_000_001_000 },
    };
    const accessBlob = await blob.encrypt(txtAccessKey, new TextEncoder().encode(JSON.stringify(json)), {
      compressed: true,
    });
    const execute = vi.fn().mockResolvedValue(rowResult({ txt_access_key: keyBlob.buffer, access: accessBlob.buffer }));
    const db = { execute } as unknown as Client;

    const result = await loadOrInitAccess(db, 42, umk);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(Array.from(result.txtAccessKey)).toEqual(Array.from(txtAccessKey));
    expect(result.accessMap).toEqual(
      new Map([
        [7, { lastPartNum: 14, lastAccessedMs: 1_700_000_000_000 }],
        [12, { lastPartNum: 2, lastAccessedMs: 1_700_000_001_000 }],
      ]),
    );
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

  it("merges the new position into the map and persists via UPDATE", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const txtAccessKey = new Uint8Array(64).fill(3);
    const currentMap: AccessMap = new Map([[7, { lastPartNum: 1, lastAccessedMs: 100 }]]);

    const next = await setReadPosition(db, 42, txtAccessKey, currentMap, 12, { lastPartNum: 3, lastAccessedMs: 200 });

    expect(next).toEqual(
      new Map([
        [7, { lastPartNum: 1, lastAccessedMs: 100 }],
        [12, { lastPartNum: 3, lastAccessedMs: 200 }],
      ]),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain("UPDATE txt_access SET access");
    expect(call.args[1]).toBe(42);
    const decrypted = await blob.decrypt(txtAccessKey, call.args[0] as Uint8Array, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({
      "7": { last_part_num: 1, last_accessed: 100 },
      "12": { last_part_num: 3, last_accessed: 200 },
    });
  });

  it("evicts the least-recently-accessed txt_id once over TXT_ACCESS_LIMIT", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const txtAccessKey = new Uint8Array(64).fill(3);

    const currentMap: AccessMap = new Map();
    for (let i = 0; i < TXT_ACCESS_LIMIT; i++) {
      currentMap.set(i, { lastPartNum: 1, lastAccessedMs: 1000 + i });
    }
    // txt_id 0 has the smallest lastAccessedMs (1000) -- should be evicted.
    const next = await setReadPosition(db, 42, txtAccessKey, currentMap, 999, {
      lastPartNum: 1,
      lastAccessedMs: 5000,
    });

    expect(next.size).toBe(TXT_ACCESS_LIMIT);
    expect(next.has(0)).toBe(false);
    expect(next.has(999)).toBe(true);
  });

  it("swallows a write failure instead of throwing, still returns the updated map", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("read-only token"));
    const db = { execute } as unknown as Client;

    const next = await setReadPosition(db, 42, new Uint8Array(64), new Map(), 7, {
      lastPartNum: 1,
      lastAccessedMs: 1,
    });

    expect(next.get(7)).toEqual({ lastPartNum: 1, lastAccessedMs: 1 });
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("removeAccessEntry", () => {
  it("removes the given txt_id and persists", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const txtAccessKey = new Uint8Array(64).fill(3);
    const currentMap: AccessMap = new Map([
      [7, { lastPartNum: 1, lastAccessedMs: 100 }],
      [12, { lastPartNum: 3, lastAccessedMs: 200 }],
    ]);

    const next = await removeAccessEntry(db, 42, txtAccessKey, currentMap, 7);

    expect(next).toEqual(new Map([[12, { lastPartNum: 3, lastAccessedMs: 200 }]]));
    const call = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    const decrypted = await blob.decrypt(txtAccessKey, call.args[0] as Uint8Array, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({
      "12": { last_part_num: 3, last_accessed: 200 },
    });
  });
});
