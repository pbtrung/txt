import { describe, expect, it } from "vitest";
import type { LibraryBook } from "../../data/libraryIndexDb";
import { allBooksSorted, booksForDimensionValue, browseEntries, matchesSearch } from "./libraryModel";

function book(overrides: Partial<LibraryBook>): LibraryBook {
  return { txtId: 1, title: "Untitled", sortKey: null, authors: [], subjects: [], publisher: null, ...overrides };
}

const LIBRARY: LibraryBook[] = [
  book({ txtId: 1, title: "Dune", sortKey: "Dune", authors: ["Frank Herbert"], subjects: ["Science Fiction"], publisher: "Ace" }),
  book({ txtId: 2, title: "The Left Hand of Darkness", authors: ["Ursula K. Le Guin"], subjects: ["Science Fiction"], publisher: "Ace" }),
  book({ txtId: 3, title: "A Wizard of Earthsea", authors: ["Ursula K. Le Guin"], subjects: ["Fantasy"], publisher: "Parnassus" }),
];

describe("allBooksSorted", () => {
  it("sorts by sort_key, falling back to title", () => {
    const titles = allBooksSorted(LIBRARY).map((b) => b.title);
    expect(titles).toEqual(["A Wizard of Earthsea", "Dune", "The Left Hand of Darkness"]);
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
});

describe("booksForDimensionValue", () => {
  it("returns every book carrying that value, sorted", () => {
    const titles = booksForDimensionValue(LIBRARY, "author", "Ursula K. Le Guin").map((b) => b.title);
    expect(titles).toEqual(["A Wizard of Earthsea", "The Left Hand of Darkness"]);
  });

  it("returns an empty list for an unknown value", () => {
    expect(booksForDimensionValue(LIBRARY, "subject", "Horror")).toEqual([]);
  });
});
