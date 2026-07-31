import { beforeEach, describe, expect, it } from "vitest";

import { SqliteDb } from "./sqliteDb";
import * as bookmarks from "./bookmarks";

let db: SqliteDb;
let dbCounter = 0;

beforeEach(async () => {
  const rootKey = new Uint8Array(256).fill(9);
  db = await SqliteDb.open(`/bookmarks-test-${dbCounter++}.db`, { rawKey: rootKey });
  db.exec(`
    CREATE TABLE txt_bookmarks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      txt_id     INTEGER NOT NULL,
      part_num   INTEGER NOT NULL,
      line       INTEGER NOT NULL,
      preview    TEXT    NOT NULL CHECK (length(preview) <= 60),
      created_at INTEGER NOT NULL,
      UNIQUE (txt_id, part_num, line)
    );
    CREATE INDEX idx_txt_bookmarks_txt_id_created_at ON txt_bookmarks(txt_id, created_at);
    CREATE TRIGGER trg_txt_bookmarks_cap
    AFTER INSERT ON txt_bookmarks
    BEGIN
      DELETE FROM txt_bookmarks
      WHERE txt_id = NEW.txt_id
        AND id NOT IN (
          SELECT id FROM txt_bookmarks
          WHERE txt_id = NEW.txt_id
          ORDER BY created_at DESC, id DESC
          LIMIT 20
        );
    END;
  `);
});

describe("addBookmark / listBookmarks", () => {
  it("adds a bookmark and lists it back, most-recent-first", () => {
    bookmarks.addBookmark(db, 1, 0, 5, "first line", 1000);
    bookmarks.addBookmark(db, 1, 0, 9, "second line", 2000);

    const list = bookmarks.listBookmarks(db, 1);
    expect(list.map((b) => b.preview)).toEqual(["second line", "first line"]);
    expect(list[0]!.txtId).toBe(1);
    expect(list[0]!.partNum).toBe(0);
    expect(list[0]!.line).toBe(9);
    expect(list[0]!.createdAt).toBe(2000);
  });

  it("truncates preview to 60 characters (schema's CHECK constraint)", () => {
    bookmarks.addBookmark(db, 1, 0, 1, "x".repeat(200), 1000);
    expect(bookmarks.listBookmarks(db, 1)[0]!.preview.length).toBe(60);
  });

  it("re-bookmarking the same line is a silent no-op", () => {
    bookmarks.addBookmark(db, 1, 0, 5, "first line", 1000);
    bookmarks.addBookmark(db, 1, 0, 5, "first line again", 2000);
    expect(bookmarks.listBookmarks(db, 1)).toHaveLength(1);
  });

  it("caps at 20 bookmarks per document via the schema's own trigger, evicting the oldest", () => {
    for (let i = 0; i < 25; i++) {
      bookmarks.addBookmark(db, 1, 0, i, `line ${i}`, i);
    }
    const list = bookmarks.listBookmarks(db, 1);
    expect(list).toHaveLength(20);
    expect(list.map((b) => b.line)).toEqual(Array.from({ length: 20 }, (_, i) => 24 - i));
  });

  it("scopes bookmarks by txt_id", () => {
    bookmarks.addBookmark(db, 1, 0, 1, "doc one", 1000);
    bookmarks.addBookmark(db, 2, 0, 1, "doc two", 1000);
    expect(bookmarks.listBookmarks(db, 1)).toHaveLength(1);
    expect(bookmarks.listBookmarks(db, 2)).toHaveLength(1);
  });
});

describe("removeBookmark", () => {
  it("removes a bookmark by id", () => {
    bookmarks.addBookmark(db, 1, 0, 1, "line", 1000);
    const id = bookmarks.listBookmarks(db, 1)[0]!.id;
    bookmarks.removeBookmark(db, id);
    expect(bookmarks.listBookmarks(db, 1)).toEqual([]);
  });
});

describe("removeAllBookmarksForTxt", () => {
  it("removes every bookmark for one document, leaving others untouched", () => {
    bookmarks.addBookmark(db, 1, 0, 1, "doc one", 1000);
    bookmarks.addBookmark(db, 2, 0, 1, "doc two", 1000);
    bookmarks.removeAllBookmarksForTxt(db, 1);
    expect(bookmarks.listBookmarks(db, 1)).toEqual([]);
    expect(bookmarks.listBookmarks(db, 2)).toHaveLength(1);
  });
});
