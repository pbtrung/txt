import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../../src/data/sqlite";

describe("SqliteDatabase numeric values", () => {
  it("preserves real-valued columns", async () => {
    const db = await SqliteDatabase.openUnkeyed();

    expect(db.query("SELECT 1.25")).toEqual([[1.25]]);
    db.close();
  });
});
