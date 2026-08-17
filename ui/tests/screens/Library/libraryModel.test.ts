import { describe, expect, it } from "vitest";
import type { LibraryBook } from "../../../src/data/libraryDb";
import {
  allBooksSorted,
  booksForDimensionValue,
  browseEntries,
  matchesSearch,
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
  it("limits access and bookmark lists to the seven newest books", () => {
    const books = Array.from({ length: 9 }, (_, index) =>
      book({
        txtId: index + 1,
        title: `Book ${index + 1}`,
        lastAccessed: index + 1,
        bookmarkCount: 1,
        lastBookmarked: 100 + index,
      }),
    );

    expect(recentlyAccessed(books).map((item) => item.txtId)).toEqual([
      9, 8, 7, 6, 5, 4, 3,
    ]);
    expect(recentlyBookmarked(books).map((item) => item.txtId)).toEqual([
      9, 8, 7, 6, 5, 4, 3,
    ]);
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

  it("matches everything for a blank query", () => {
    expect(matchesSearch(LIBRARY[0], "   ")).toBe(true);
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
