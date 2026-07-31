import type { Client } from "@libsql/core/api";
import { describe, expect, it, vi } from "vitest";

import { deleteTxtRows } from "./adminTxt";

function emptyResult() {
  return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
}

describe("deleteTxtRows", () => {
  it("deletes txt_parts, txt_shares, part_count, and the txt row itself -- nothing else", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;

    await deleteTxtRows(db, 7);

    expect(execute).toHaveBeenCalledTimes(4);
    const calls = execute.mock.calls.map(([stmt]) => stmt as { sql: string; args: unknown[] });
    expect(calls[0]).toEqual({ sql: "DELETE FROM txt_parts WHERE txt_id = ?", args: [7] });
    expect(calls[1]).toEqual({ sql: "DELETE FROM txt_shares WHERE txt_id = ?", args: [7] });
    expect(calls[2]).toEqual({ sql: "DELETE FROM part_count WHERE txt_id = ?", args: [7] });
    expect(calls[3]).toEqual({ sql: "DELETE FROM txt WHERE id = ?", args: [7] });
  });

  it("never issues any R2 call or any statement mentioning txt_metadata/txt_access/bookmarks", async () => {
    const execute = vi.fn().mockResolvedValue(emptyResult());
    const db = { execute } as unknown as Client;

    await deleteTxtRows(db, 3);

    for (const [stmt] of execute.mock.calls) {
      const sql = (stmt as { sql: string }).sql;
      expect(sql).not.toMatch(/txt_metadata|txt_access|bookmarks/);
    }
  });
});
