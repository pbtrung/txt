import type { Client } from "@libsql/core/api";
import { describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { loadOrInitPerUserBlob, savePerUserBlob } from "./perUserBlob";

const TABLE = { table: "some_table", keyColumn: "some_key", blobColumn: "some_blob" };

function emptyResult() {
  return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

function rowResult(row: Record<string, unknown>) {
  return { ...emptyResult(), rows: [row] };
}

describe("loadOrInitPerUserBlob", () => {
  it("creates a new row (wrapped key + encrypted empty JSON) when none exists", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const umk = new Uint8Array(64).fill(1);

    const { key, value } = await loadOrInitPerUserBlob(db, TABLE, 42, umk, 64, (json) => json, "empty-default");

    expect(key.length).toBe(64);
    expect(value).toBe("empty-default");
    expect(execute).toHaveBeenCalledTimes(2);

    const selectCall = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(selectCall.sql).toBe("SELECT some_key, some_blob FROM some_table WHERE user_id = ?");
    expect(selectCall.args).toEqual([42]);

    const insertCall = execute.mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(insertCall.sql).toBe("INSERT INTO some_table (user_id, some_key, some_blob) VALUES (?, ?, ?)");
    expect(insertCall.args[0]).toBe(42);
    const unwrappedKey = await blob.decrypt(umk, insertCall.args[1] as Uint8Array);
    expect(Array.from(unwrappedKey)).toEqual(Array.from(key));
    const decrypted = await blob.decrypt(key, insertCall.args[2] as Uint8Array, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({});
  });

  it("decrypts and parses an existing row via the given `parse`", async () => {
    const umk = new Uint8Array(64).fill(1);
    const key = new Uint8Array(64).fill(2);
    const keyBlob = await blob.encrypt(umk, key);
    const valueBlob = await blob.encrypt(key, new TextEncoder().encode(JSON.stringify({ foo: "bar" })), {
      compressed: true,
    });
    const execute = vi.fn().mockResolvedValue(rowResult({ some_key: keyBlob.buffer, some_blob: valueBlob.buffer }));
    const db = { execute } as unknown as Client;

    const result = await loadOrInitPerUserBlob(
      db,
      TABLE,
      42,
      umk,
      64,
      (json) => (json as { foo: string }).foo,
      "unused-default",
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(Array.from(result.key)).toEqual(Array.from(key));
    expect(result.value).toBe("bar");
  });
});

describe("savePerUserBlob", () => {
  it("encrypts the given JSON under the key and issues the UPDATE", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;
    const key = new Uint8Array(64).fill(3);

    await savePerUserBlob(db, TABLE, 42, key, { hello: "world" });

    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toBe("UPDATE some_table SET some_blob = ? WHERE user_id = ?");
    expect(call.args[1]).toBe(42);
    const decrypted = await blob.decrypt(key, call.args[0] as Uint8Array, true);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({ hello: "world" });
  });
});
