import type { Client } from "@libsql/core/api";
import { describe, expect, it, vi } from "vitest";

import * as kem from "../crypto/kem";
import * as adminShares from "./adminShares";

function emptyResult() {
  return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

function rowsResult(rows: Record<string, unknown>[]) {
  return { ...emptyResult(), rows };
}

describe("listShares", () => {
  it("returns [] without querying at all when the admin has no txt yet", async () => {
    const execute = vi.fn();
    const db = { execute } as unknown as Client;
    expect(await adminShares.listShares(db, [])).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("lists shares scoped to the given txt ids", async () => {
    const execute = vi.fn(async ({ sql, args }: { sql: string; args?: unknown[] }) => {
      expect(sql).toContain("txt_id IN (?, ?)");
      expect(args).toEqual([7, 9]);
      return rowsResult([
        { id: 1, txt_id: 7, to_user_id: 3 },
        { id: 2, txt_id: 9, to_user_id: 4 },
      ]);
    });
    const db = { execute } as unknown as Client;

    const shares = await adminShares.listShares(db, [7, 9]);

    expect(shares).toEqual([
      { id: 1, txtId: 7, toUserId: 3 },
      { id: 2, txtId: 9, toUserId: 4 },
    ]);
  });
});

describe("grantShare", () => {
  it("wraps the txt key for the recipient's public key and inserts a share row", async () => {
    const { pk, sk } = await kem.keypair();
    const execute = vi.fn(async ({ sql }: { sql: string }) => {
      if (sql.startsWith("SELECT")) return rowsResult([{ pub_key: pk.buffer }]);
      return emptyResult();
    });
    const db = { execute } as unknown as Client;
    const txtKey = new Uint8Array(64).fill(3);

    await adminShares.grantShare(db, 7, txtKey, 42);

    const insertCall = execute.mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(insertCall.sql).toContain("INSERT INTO txt_shares");
    expect(insertCall.args[0]).toBe(7);
    expect(insertCall.args[1]).toBe(42);
    const saltKemCt = insertCall.args[2] as Uint8Array;
    const wrappedTxtKey = insertCall.args[3] as Uint8Array;

    const recovered = await kem.unwrap(sk, saltKemCt, wrappedTxtKey);
    expect(Array.from(recovered)).toEqual(Array.from(txtKey));
  });

  it("throws when the recipient has no key_store row", async () => {
    const execute = vi.fn().mockResolvedValue(rowsResult([]));
    const db = { execute } as unknown as Client;
    await expect(adminShares.grantShare(db, 7, new Uint8Array(64), 42)).rejects.toThrow(adminShares.AdminSharesError);
  });
});

describe("revokeShare", () => {
  it("deletes the share row by id", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;

    await adminShares.revokeShare(db, 5);

    expect(execute).toHaveBeenCalledWith({ sql: "DELETE FROM txt_shares WHERE id = ?", args: [5] });
  });
});
