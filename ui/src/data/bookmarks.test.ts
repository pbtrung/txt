import { describe, expect, it } from "vitest";

import {
  BOOKMARKS_MAX_PER_DOC,
  addBookmark,
  decodeBookmarksContent,
  encodeBookmarksContent,
  removeBookmark,
  type BookmarksMap,
} from "./bookmarks";

describe("addBookmark / removeBookmark", () => {
  it("adds a bookmark and lists it back, most-recent-first", () => {
    let map: BookmarksMap = {};
    map = addBookmark(map, "txt-1", 0, 5, "first line", 1000);
    map = addBookmark(map, "txt-1", 0, 9, "second line", 2000);

    const list = map["txt-1"]!;
    expect(list.map((b) => b.preview)).toEqual(["second line", "first line"]);
    expect(list[0]!.partNum).toBe(0);
    expect(list[0]!.line).toBe(9);
    expect(list[0]!.createdAt).toBe(2000);
  });

  it("truncates preview to 60 characters", () => {
    let map: BookmarksMap = {};
    map = addBookmark(map, "txt-1", 0, 1, "x".repeat(200), 1000);
    expect(map["txt-1"]![0]!.preview.length).toBe(60);
  });

  it("re-bookmarking the same line is a silent no-op", () => {
    let map: BookmarksMap = {};
    map = addBookmark(map, "txt-1", 0, 5, "first line", 1000);
    map = addBookmark(map, "txt-1", 0, 5, "first line again", 2000);
    expect(map["txt-1"]).toHaveLength(1);
  });

  it("caps at BOOKMARKS_MAX_PER_DOC per document, evicting the oldest", () => {
    let map: BookmarksMap = {};
    for (let i = 0; i < 25; i++) {
      map = addBookmark(map, "txt-1", 0, i, `line ${i}`, i);
    }
    const list = map["txt-1"]!;
    expect(list).toHaveLength(BOOKMARKS_MAX_PER_DOC);
    expect(list.map((b) => b.line)).toEqual(
      Array.from({ length: BOOKMARKS_MAX_PER_DOC }, (_, i) => 24 - i),
    );
  });

  it("groups bookmarks by txt_id", () => {
    let map: BookmarksMap = {};
    map = addBookmark(map, "txt-1", 0, 1, "doc one", 1000);
    map = addBookmark(map, "txt-2", 0, 1, "doc two", 1000);
    expect(map["txt-1"]).toHaveLength(1);
    expect(map["txt-2"]).toHaveLength(1);
  });

  it("removes a bookmark by id", () => {
    let map: BookmarksMap = {};
    map = addBookmark(map, "txt-1", 0, 1, "line", 1000);
    const id = map["txt-1"]![0]!.id;
    map = removeBookmark(map, "txt-1", id);
    expect(map["txt-1"]).toBeUndefined();
  });
});

describe("decodeBookmarksContent / encodeBookmarksContent", () => {
  it("round-trips a well-formed map", () => {
    let map: BookmarksMap = {};
    map = addBookmark(map, "txt-1", 0, 5, "hello", 1000);
    const decoded = decodeBookmarksContent(encodeBookmarksContent(map));
    expect(decoded).toEqual(map);
  });

  it("drops entries that don't match the expected shape", () => {
    const decoded = decodeBookmarksContent({
      "txt-1": [{ part_num: 0, line: 1, txt_preview: "ok", created_at: 100 }],
      "txt-2": [{ part_num: "bad" }],
      "txt-3": "not an array",
    });
    expect(Object.keys(decoded)).toEqual(["txt-1"]);
  });

  it("returns an empty map for non-object input", () => {
    expect(decodeBookmarksContent(null)).toEqual({});
  });
});
