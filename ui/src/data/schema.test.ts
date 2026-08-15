import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "./sqlite";
import { ensureSchema, PAGE_SIZE } from "./schema";

describe("ensureSchema (real sqlcipher.wasm)", () => {
  it("creates txt and txt_bookmarks with the 16 KiB page size", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);

    expect(Number(db.query("PRAGMA page_size")[0][0])).toBe(PAGE_SIZE);
    expect(db.query("SELECT count(*) FROM txt")).toEqual([[0]]);
    expect(db.query("SELECT count(*) FROM txt_bookmarks")).toEqual([[0]]);
    db.close();
  });

  it("is idempotent -- reapplying on an existing database is a no-op", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    db.execSql(
      "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, created_at) " +
        "VALUES (x'00', x'00', x'00', x'00', 0, 0)",
    );

    expect(() => ensureSchema(db)).not.toThrow();
    expect(db.query("SELECT count(*) FROM txt")).toEqual([[1]]);
    db.close();
  });

  it("caps txt_bookmarks at 20 rows per document", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    db.execSql(
      "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, created_at) " +
        "VALUES (x'00', x'00', x'00', x'00', 0, 0)",
    );
    for (let line = 0; line < 25; line++) {
      db.execSql(
        `INSERT INTO txt_bookmarks (txt_id, line, preview, created_at) VALUES (1, ${line}, 'p', 0)`,
      );
    }

    expect(db.query("SELECT count(*) FROM txt_bookmarks")).toEqual([[20]]);
    db.close();
  });
});
