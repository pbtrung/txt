import { describe, expect, it } from "vitest";

import type { AccessMap } from "../../data/access";
import type { BookmarksMap } from "../../data/bookmarks";
import type { BookInfo } from "../../data/metadata";
import {
  allBooksSorted,
  bookStatus,
  browseEntries,
  buildLibraryBooks,
  booksForDimensionValue,
  matchesSearch,
  recentBookmarks,
  recentBooks,
  type LibraryBook,
} from "./libraryModel";

function book(overrides: Partial<LibraryBook> & { txtId: number }): LibraryBook {
  return {
    info: {
      txtId: overrides.txtId,
      name: `t${overrides.txtId}`,
      title: `Title ${overrides.txtId}`,
      subjects: [],
      rawMetadata: [],
    },
    lastPartNum: null,
    lastAccessedMs: null,
    ...overrides,
  };
}

describe("bookStatus", () => {
  it("is not-started when there's no read position", () => {
    expect(bookStatus(book({ txtId: 1 }))).toBe("not-started");
  });

  it("is in-progress once a part has been read", () => {
    expect(bookStatus(book({ txtId: 1, lastPartNum: 14 }))).toBe("in-progress");
  });
});

describe("buildLibraryBooks", () => {
  it("combines metadata with read position, keyed by txt_id", () => {
    const metadataById = new Map<number, BookInfo>([
      [7, { txtId: 7, name: "n7", title: "Title 7", subjects: [], rawMetadata: [] }],
      [8, { txtId: 8, name: "n8", title: "Title 8", subjects: [], rawMetadata: [] }],
    ]);
    const accessMap: AccessMap = new Map([[7, { lastPartNum: 14, lastAccessedMs: 1000 }]]);

    const books = buildLibraryBooks(metadataById, accessMap);

    expect(books).toEqual([
      { txtId: 7, info: metadataById.get(7), lastPartNum: 14, lastAccessedMs: 1000 },
      { txtId: 8, info: metadataById.get(8), lastPartNum: null, lastAccessedMs: null },
    ]);
  });

  it("returns every metadata entry even with an empty access map", () => {
    const metadataById = new Map<number, BookInfo>([
      [7, { txtId: 7, name: "n7", title: "Title 7", subjects: [], rawMetadata: [] }],
    ]);
    expect(buildLibraryBooks(metadataById, new Map())).toHaveLength(1);
  });
});

describe("recentBooks", () => {
  it("keeps only opened books, most recent first", () => {
    const books = [
      book({ txtId: 1, lastAccessedMs: 1000 }),
      book({ txtId: 2, lastAccessedMs: null }),
      book({ txtId: 3, lastAccessedMs: 3000 }),
      book({ txtId: 4, lastAccessedMs: 2000 }),
    ];
    expect(recentBooks(books).map((b) => b.txtId)).toEqual([3, 4, 1]);
  });
});

describe("allBooksSorted", () => {
  it("sorts by title", () => {
    const books = [
      book({ txtId: 1, info: { txtId: 1, name: "b", title: "Beta", subjects: [], rawMetadata: [] } }),
      book({ txtId: 2, info: { txtId: 2, name: "a", title: "Alpha", subjects: [], rawMetadata: [] } }),
    ];
    expect(allBooksSorted(books).map((b) => b.info.title)).toEqual(["Alpha", "Beta"]);
  });
});

describe("matchesSearch", () => {
  const b = book({
    txtId: 1,
    info: {
      txtId: 1,
      name: "n",
      title: "The White Order",
      author: "L. E. Modesitt, Jr.",
      subjects: ["Fantasy", "Military"],
      publisher: "Tor Publishing Group",
      rawMetadata: [],
    },
  });

  it("matches title, author, subject, and publisher case-insensitively", () => {
    expect(matchesSearch(b, "white")).toBe(true);
    expect(matchesSearch(b, "MODESITT")).toBe(true);
    expect(matchesSearch(b, "fantasy")).toBe(true);
    expect(matchesSearch(b, "tor publishing")).toBe(true);
    expect(matchesSearch(b, "nonexistent")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesSearch(b, "")).toBe(true);
    expect(matchesSearch(b, "   ")).toBe(true);
  });
});

describe("browseEntries / booksForDimensionValue", () => {
  const books = [
    book({
      txtId: 1,
      info: {
        txtId: 1,
        name: "n1",
        title: "T1",
        author: "Author A",
        subjects: ["Fantasy", "Military"],
        publisher: "Pub X",
        rawMetadata: [],
      },
    }),
    book({
      txtId: 2,
      info: {
        txtId: 2,
        name: "n2",
        title: "T2",
        author: "Author B",
        subjects: ["Fantasy"],
        publisher: "Pub X",
        rawMetadata: [],
      },
    }),
    book({
      txtId: 3,
      info: { txtId: 3, name: "n3", title: "T3", subjects: [], rawMetadata: [] }, // no author/publisher
    }),
  ];

  it("counts distinct authors", () => {
    expect(browseEntries(books, "author")).toEqual([
      { value: "Author A", count: 1 },
      { value: "Author B", count: 1 },
    ]);
  });

  it("counts distinct subjects, tallying repeats across books", () => {
    expect(browseEntries(books, "subject")).toEqual([
      { value: "Fantasy", count: 2 },
      { value: "Military", count: 1 },
    ]);
  });

  it("counts distinct publishers", () => {
    expect(browseEntries(books, "publisher")).toEqual([{ value: "Pub X", count: 2 }]);
  });

  it("filters books by a dimension value", () => {
    expect(booksForDimensionValue(books, "subject", "Fantasy").map((b) => b.txtId)).toEqual([1, 2]);
    expect(booksForDimensionValue(books, "author", "Author A").map((b) => b.txtId)).toEqual([1]);
  });
});

describe("recentBookmarks", () => {
  it("flattens every txt_id's bookmarks, most recently created first", () => {
    const metadataById = new Map<number, BookInfo>([
      [7, { txtId: 7, name: "n7", title: "The White Order", subjects: [], rawMetadata: [] }],
      [8, { txtId: 8, name: "n8", title: "Unshrinking", subjects: [], rawMetadata: [] }],
    ]);
    const bookmarksMap: BookmarksMap = new Map([
      [
        7,
        [
          { partNum: 14, line: 1, txtPreview: "Powerful white mages", createdAt: 1000 },
          { partNum: 20, line: 2, txtPreview: "Cerryl witnessed", createdAt: 3000 },
        ],
      ],
      [8, [{ partNum: 2, line: 3, txtPreview: "She knew that fatphobia", createdAt: 2000 }]],
    ]);

    const items = recentBookmarks(bookmarksMap, metadataById);

    expect(items.map((i) => i.createdAt)).toEqual([3000, 2000, 1000]);
    expect(items[0]).toEqual({
      txtId: 7,
      info: metadataById.get(7),
      partNum: 20,
      line: 2,
      txtPreview: "Cerryl witnessed",
      createdAt: 3000,
    });
  });

  it("falls back to a placeholder title when metadata is missing", () => {
    const bookmarksMap: BookmarksMap = new Map([[9, [{ partNum: 1, line: 1, txtPreview: "x", createdAt: 1000 }]]]);
    const items = recentBookmarks(bookmarksMap, new Map());
    expect(items[0].info.title).toBe("txt_9");
  });

  it("returns an empty list when there are no bookmarks", () => {
    expect(recentBookmarks(new Map(), new Map())).toEqual([]);
  });
});
