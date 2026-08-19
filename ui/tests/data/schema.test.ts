import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "../../src/data/sqlite";
import { ensureSchema, PAGE_SIZE } from "../../src/data/schema";

describe("ensureSchema (real sqlcipher.wasm)", () => {
  it("creates catalog, reading, and sharing tables with 16 KiB pages", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);

    expect(Number(db.query("PRAGMA page_size")[0][0])).toBe(PAGE_SIZE);
    expect(db.query("PRAGMA foreign_keys")).toEqual([[1]]);
    expect(db.query("SELECT count(*) FROM txt")).toEqual([[0]]);
    expect(db.query("SELECT count(*) FROM txt_bookmarks")).toEqual([[0]]);
    expect(db.query("SELECT count(*) FROM txt_shares")).toEqual([[0]]);
    expect(db.query("PRAGMA table_info(txt)").map((row) => row[1])).toContain(
      "last_cfi",
    );
    const bookmarkColumns = db
      .query("PRAGMA table_info(txt_bookmarks)")
      .map((row) => row[1]);
    expect(bookmarkColumns).toContain("cfi");
    expect(bookmarkColumns).toContain("page_number");
    expect(bookmarkColumns).not.toContain("line");
    expect(db.query("SELECT name FROM txt_schema_migrations")).toEqual([
      ["reset_initial_last_accessed"],
    ]);
    expect(db.query("PRAGMA user_version")).toEqual([[0]]);
    db.close();
  });

  it("enforces independent share material and restricts source deletion", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    db.execSql(
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
        "VALUES (x'00', x'00', x'00', x'00', 0, 0)",
    );
    db.execute(
      "INSERT INTO txt_shares " +
        "(txt_id, share_id, share_content_key, share_prefix, share_path, state, created_at) " +
        "VALUES (1, ?, ?, ?, ?, 'active', 0)",
      [
        new Uint8Array(32),
        new Uint8Array(128),
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      ],
    );

    expect(() => db.execSql("DELETE FROM txt WHERE id = 1")).toThrow(/FOREIGN KEY/);
    expect(db.query("SELECT state FROM txt_shares")).toEqual([["active"]]);
    db.close();
  });

  it("is idempotent -- reapplying on an existing database is a no-op", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    db.execSql(
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
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
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
        "VALUES (x'00', x'00', x'00', x'00', 0, 0)",
    );
    for (let location = 0; location < 25; location++) {
      db.execute(
        "INSERT INTO txt_bookmarks (txt_id, cfi, preview, created_at) " +
          "VALUES (1, ?, 'p', 0)",
        [`epubcfi(/6/${location})`],
      );
    }

    expect(db.query("SELECT count(*) FROM txt_bookmarks")).toEqual([[20]]);
    db.close();
  });

  it("cascades bookmark deletion when a document is deleted", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    db.execSql(
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
        "VALUES (x'00', x'00', x'00', x'00', 0, 0)",
    );
    db.execSql(
      "INSERT INTO txt_bookmarks (txt_id, cfi, preview, created_at) " +
        "VALUES (1, 'epubcfi(/6/2)', 'preview', 0)",
    );

    db.execSql("DELETE FROM txt WHERE id = 1");

    expect(db.query("SELECT count(*) FROM txt_bookmarks")).toEqual([[0]]);
    db.close();
  });

  it("enforces the preview cap in UTF-8 bytes", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    db.execSql(
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
        "VALUES (x'00', x'00', x'00', x'00', 0, 0)",
    );

    db.execute(
      "INSERT INTO txt_bookmarks (txt_id, cfi, preview, created_at) VALUES (1, ?, ?, 0)",
      ["epubcfi(/6/2)", "é".repeat(50)],
    );
    expect(() =>
      db.execute(
        "INSERT INTO txt_bookmarks (txt_id, cfi, preview, created_at) " +
          "VALUES (1, ?, ?, 0)",
        ["epubcfi(/6/4)", `${"é".repeat(50)}a`],
      ),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("rebuilds an empty legacy line-bookmark table", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    db.execSql(`
      CREATE TABLE txt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        txt_key BLOB NOT NULL,
        txt_prefix BLOB NOT NULL,
        path BLOB NOT NULL,
        catalog BLOB NOT NULL,
        last_accessed INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE txt_bookmarks (
        id INTEGER PRIMARY KEY,
        txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
        line INTEGER NOT NULL,
        preview TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (txt_id, line)
      );
    `);

    ensureSchema(db);

    expect(db.query("PRAGMA table_info(txt)").map((row) => row[1])).toContain(
      "last_cfi",
    );
    expect(db.query("PRAGMA table_info(txt_bookmarks)").map((row) => row[1])).toContain(
      "cfi",
    );
    expect(db.query("SELECT name FROM txt_schema_migrations")).toEqual([]);
    db.close();
  });

  it("rolls back when legacy line bookmarks contain data", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    db.execSql(`
      CREATE TABLE txt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        txt_key BLOB NOT NULL,
        txt_prefix BLOB NOT NULL,
        path BLOB NOT NULL,
        catalog BLOB NOT NULL,
        last_accessed INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE txt_bookmarks (
        id INTEGER PRIMARY KEY,
        txt_id INTEGER NOT NULL REFERENCES txt(id) ON DELETE CASCADE,
        line INTEGER NOT NULL,
        preview TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO txt VALUES (1, x'00', x'00', x'00', x'00', 0, 0);
      INSERT INTO txt_bookmarks VALUES (1, 1, 42, 'legacy', 0);
    `);

    expect(() => ensureSchema(db)).toThrow(/cannot migrate.*CFI/);
    expect(db.query("PRAGMA table_info(txt)").map((row) => row[1])).not.toContain(
      "last_cfi",
    );
    expect(db.query("PRAGMA table_info(txt_bookmarks)").map((row) => row[1])).toContain(
      "line",
    );
    db.close();
  });
});
