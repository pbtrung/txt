import { describe, expect, it } from "vitest";
import type { LibraryBook } from "../../../src/data/libraryDb";
import {
  allBooksSorted,
  booksForDimensionValue,
  browseEntries,
  createBookSearch,
  parseSearch,
  recentBookCount,
  recentlyAccessed,
  recentlyBookmarked,
} from "../../../src/screens/Library/libraryModel";

function book(overrides: Partial<LibraryBook>): LibraryBook {
  return {
    txtId: 1,
    title: "Untitled",
    authors: [],
    subjects: [],
    publisher: null,
    lastAccessed: 0,
    bookmarkCount: 0,
    lastBookmarked: null,
    latestBookmarkCfi: null,
    bookmarks: [],
    ...overrides,
  };
}

const LIBRARY: LibraryBook[] = [
  book({
    txtId: 1,
    title: "Dune",
    authors: ["Frank Herbert"],
    subjects: ["Science Fiction"],
    publisher: "Ace",
  }),
  book({
    txtId: 2,
    title: "The Left Hand of Darkness",
    authors: ["Ursula K. Le Guin"],
    subjects: ["Science Fiction"],
    publisher: "Ace",
  }),
  book({
    txtId: 3,
    title: "A Wizard of Earthsea",
    authors: ["Ursula K. Le Guin"],
    subjects: ["Fantasy"],
    publisher: "Parnassus",
  }),
];

function matchesSearch(book: LibraryBook, query: string): boolean {
  return createBookSearch([book]).search(query).length === 1;
}

describe("allBooksSorted", () => {
  it("sorts by title", () => {
    const titles = allBooksSorted(LIBRARY).map((b) => b.title);
    expect(titles).toEqual([
      "A Wizard of Earthsea",
      "Dune",
      "The Left Hand of Darkness",
    ]);
  });
});

describe("recent books", () => {
  it("limits access items and bookmark entries to the seven newest", () => {
    const books = Array.from({ length: 9 }, (_, index) =>
      book({
        txtId: index + 1,
        title: `Book ${index + 1}`,
        lastAccessed: index + 1,
        bookmarkCount: 1,
        lastBookmarked: 100 + index,
        bookmarks: [
          {
            cfi: `bookmark-${index + 1}`,
            pageNumber: index + 1,
            createdAt: 100 + index,
          },
        ],
      }),
    );

    expect(recentlyAccessed(books).map((item) => item.txtId)).toEqual([
      9, 8, 7, 6, 5, 4, 3,
    ]);
    expect(recentlyBookmarked(books).map((item) => item.book.txtId)).toEqual([
      9, 8, 7, 6, 5, 4, 3,
    ]);
  });

  it("limits multiple bookmarks from one book to seven entries", () => {
    const marked = book({
      bookmarkCount: 9,
      bookmarks: Array.from({ length: 9 }, (_, index) => ({
        cfi: `bookmark-${index + 1}`,
        pageNumber: index + 1,
        createdAt: index + 1,
      })),
    });

    expect(
      recentlyBookmarked([marked]).map((item) => item.bookmark.pageNumber),
    ).toEqual([9, 8, 7, 6, 5, 4, 3]);
  });

  it("counts each active book only once", () => {
    const books = [
      book({ txtId: 1, lastAccessed: 10, bookmarkCount: 2 }),
      book({ txtId: 2, bookmarkCount: 1 }),
      book({ txtId: 3 }),
    ];
    expect(recentBookCount(books)).toBe(2);
  });
});

describe("matchesSearch", () => {
  it("matches on title, author, subject, and publisher, case-insensitively", () => {
    expect(matchesSearch(LIBRARY[0], "dune")).toBe(true);
    expect(matchesSearch(LIBRARY[0], "HERBERT")).toBe(true);
    expect(matchesSearch(LIBRARY[0], "science fiction")).toBe(true);
    expect(matchesSearch(LIBRARY[0], "ace")).toBe(true);
    expect(matchesSearch(LIBRARY[0], "fantasy")).toBe(false);
  });

  it("tolerates typos and ignores diacritics", () => {
    const accented = book({ title: "Đi tìm thời gian đã mất" });

    expect(matchesSearch(LIBRARY[0], "dne")).toBe(true);
    expect(matchesSearch(accented, "di tim thoi gian")).toBe(true);
  });

  it("requires every word in a multi-word query to match", () => {
    expect(matchesSearch(LIBRARY[0], "dune herbert")).toBe(true);
    expect(matchesSearch(LIBRARY[0], "dune le guin")).toBe(false);
  });

  it("matches everything for a blank query", () => {
    expect(matchesSearch(LIBRARY[0], "   ")).toBe(true);
  });

  it("filters accessed and bookmarked books with a:/b: expressions", () => {
    const accessed = book({ title: "Dune", lastAccessed: 42 });
    const bookmarked = book({ title: "Earthsea", bookmarkCount: 1 });

    expect(matchesSearch(accessed, "a:*")).toBe(true);
    expect(matchesSearch(bookmarked, "a:*")).toBe(false);
    expect(matchesSearch(accessed, "a:'dune'")).toBe(true);
    expect(matchesSearch(accessed, "a:'earth'")).toBe(false);
    expect(matchesSearch(bookmarked, "b:*")).toBe(true);
    expect(matchesSearch(bookmarked, "b:'earth'")).toBe(true);
    expect(matchesSearch(accessed, "b:'dune'")).toBe(false);
  });
});

describe("createBookSearch", () => {
  it("ranks a title match ahead of the same term in metadata", () => {
    const results = createBookSearch([
      book({ txtId: 1, title: "Dune", authors: ["Frank Herbert"] }),
      book({ txtId: 2, title: "Collected Works", subjects: ["Dune"] }),
    ]).search("dune");

    expect(results.map((item) => item.txtId)).toEqual([1, 2]);
  });

  it("reuses one index for successive queries", () => {
    const search = createBookSearch(LIBRARY);

    expect(search.search("dune").map((item) => item.title)).toEqual(["Dune"]);
    expect(search.search("wizard").map((item) => item.title)).toEqual([
      "A Wizard of Earthsea",
    ]);
  });
});

describe("parseSearch", () => {
  it("parses activity wildcards and quoted text case-insensitively", () => {
    expect(parseSearch(" A:* ")).toEqual({ activity: "access", text: "" });
    expect(parseSearch("B:'Some Text'")).toEqual({
      activity: "bookmark",
      text: "some text",
    });
  });

  it("leaves malformed activity expressions as ordinary searches", () => {
    expect(parseSearch("a:unquoted")).toEqual({
      activity: null,
      text: "a:unquoted",
    });
  });
});

describe("browseEntries", () => {
  it("counts distinct values per dimension, sorted alphabetically", () => {
    expect(browseEntries(LIBRARY, "author")).toEqual([
      { value: "Frank Herbert", count: 1 },
      { value: "Ursula K. Le Guin", count: 2 },
    ]);
    expect(browseEntries(LIBRARY, "publisher")).toEqual([
      { value: "Ace", count: 2 },
      { value: "Parnassus", count: 1 },
    ]);
  });

  it("counts a repeated value only once per book and ignores blanks", () => {
    const duplicate = book({ authors: ["Ada", "Ada", " "] });

    expect(browseEntries([duplicate], "author")).toEqual([{ value: "Ada", count: 1 }]);
  });
});

describe("booksForDimensionValue", () => {
  it("returns every book carrying that value, sorted", () => {
    const titles = booksForDimensionValue(LIBRARY, "author", "Ursula K. Le Guin").map(
      (b) => b.title,
    );
    expect(titles).toEqual(["A Wizard of Earthsea", "The Left Hand of Darkness"]);
  });

  it("returns an empty list for an unknown value", () => {
    expect(booksForDimensionValue(LIBRARY, "subject", "Horror")).toEqual([]);
  });
});
