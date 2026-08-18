import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryBook } from "../../../src/data/libraryDb";

const fuse = vi.hoisted(() => ({ search: vi.fn(() => []) }));

vi.mock("fuse.js", () => ({
  default: vi.fn(function MockFuse() {
    return { search: fuse.search };
  }),
}));

import Fuse from "fuse.js";
import { createBookSearch } from "../../../src/screens/Library/libraryModel";

const BOOKS: LibraryBook[] = [
  {
    txtId: 1,
    title: "Dune",
    authors: ["Frank Herbert"],
    subjects: ["Science Fiction"],
    publisher: "Ace",
    lastAccessed: 0,
    bookmarkCount: 0,
    lastBookmarked: null,
    latestBookmarkCfi: null,
  },
];

beforeEach(() => vi.clearAllMocks());

describe("library search fast path", () => {
  it("builds once and skips fuzzy matching for exact query updates", () => {
    const search = createBookSearch(BOOKS);

    expect(search.search("d")).toEqual(BOOKS);
    expect(search.search("du")).toEqual(BOOKS);
    expect(search.search("dune")).toEqual(BOOKS);
    expect(Fuse).toHaveBeenCalledOnce();
    expect(fuse.search).not.toHaveBeenCalled();
  });

  it("falls back to Fuse when exact matching finds nothing", () => {
    const search = createBookSearch(BOOKS);

    search.search("dne");

    expect(fuse.search).toHaveBeenCalledWith("dne");
  });
});
