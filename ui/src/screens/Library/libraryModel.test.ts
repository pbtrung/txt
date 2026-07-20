import type { Client } from "@libsql/core/api";
import { describe, expect, it, vi } from "vitest";

import {
  allBooksSorted,
  bookProgressPercent,
  bookStatus,
  browseEntries,
  booksForDimensionValue,
  loadLibraryBooks,
  loadPartCount,
  matchesSearch,
  recentBooks,
  type LibraryBook,
} from "./libraryModel";

function book(overrides: Partial<LibraryBook> & { txtId: number }): LibraryBook {
  return {
    info: { txtId: overrides.txtId, name: `t${overrides.txtId}`, title: `Title ${overrides.txtId}`, subjects: [] },
    partCount: 10,
    lastPartNum: null,
    lastAccessedMs: null,
    ...overrides,
  };
}

describe("bookStatus / bookProgressPercent", () => {
  it("is not-started when there's no read position", () => {
    const b = book({ txtId: 1 });
    expect(bookStatus(b)).toBe("not-started");
    expect(bookProgressPercent(b)).toBe(0);
  });

  it("is in-progress partway through", () => {
    const b = book({ txtId: 1, partCount: 40, lastPartNum: 14 });
    expect(bookStatus(b)).toBe("in-progress");
    expect(bookProgressPercent(b)).toBe(35);
  });

  it("is finished once the last part has been read", () => {
    const b = book({ txtId: 1, partCount: 40, lastPartNum: 40 });
    expect(bookStatus(b)).toBe("finished");
    expect(bookProgressPercent(b)).toBe(100);
  });

  it("assumes in-progress (not finished) while partCount hasn't loaded yet", () => {
    const b = book({ txtId: 1, partCount: null, lastPartNum: 14 });
    expect(bookStatus(b)).toBe("in-progress");
    expect(bookProgressPercent(b)).toBe(0);
  });

  it("stays not-started with no read position, regardless of partCount", () => {
    const b = book({ txtId: 1, partCount: null, lastPartNum: null });
    expect(bookStatus(b)).toBe("not-started");
  });
});

describe("loadLibraryBooks", () => {
  function fakeClient(rows: Record<string, unknown[]>): Client {
    return {
      async execute({ sql }: { sql: string }) {
        for (const [needle, resultRows] of Object.entries(rows)) {
          if (sql.includes(needle)) {
            return { rows: resultRows, columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
          }
        }
        throw new Error(`no handler for SQL: ${sql}`);
      },
    } as unknown as Client;
  }

  it("does not fetch part_count -- every loaded book's partCount is null", async () => {
    const umk = new Uint8Array(64).fill(1);
    const db = fakeClient({
      "FROM txt WHERE user_id": [{ id: 7 }],
      "FROM txt_metadata": [{ txt_metadata_key: null, content: null }],
      "FROM txt_access": [],
    });
    const getTxtKey = vi.fn().mockResolvedValue(new Uint8Array(64));

    const books = await loadLibraryBooks(db, 42, umk, getTxtKey);

    expect(books).toHaveLength(1);
    expect(books[0].partCount).toBeNull();
  });

  it("skips a book whose data fails to load instead of rejecting the whole list", async () => {
    const umk = new Uint8Array(64).fill(1);
    const db = fakeClient({
      "FROM txt WHERE user_id": [{ id: 7 }, { id: 8 }],
      "FROM txt_metadata": [{ txt_metadata_key: null, content: null }],
      "FROM txt_access": [],
    });
    const getTxtKey = vi.fn().mockImplementation(async (txtId: number) => {
      if (txtId === 7) throw new Error("simulated failure (e.g. a 404)");
      return new Uint8Array(64);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const books = await loadLibraryBooks(db, 42, umk, getTxtKey);

    expect(books.map((b) => b.txtId)).toEqual([8]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("loadPartCount", () => {
  it("fetches a single book's part count", async () => {
    const db = {
      async execute() {
        return { rows: [{ count: 41 }], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) };
      },
    } as unknown as Client;
    expect(await loadPartCount(db, 7)).toBe(41);
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
      book({ txtId: 1, info: { txtId: 1, name: "b", title: "Beta", subjects: [] } }),
      book({ txtId: 2, info: { txtId: 2, name: "a", title: "Alpha", subjects: [] } }),
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
      info: { txtId: 1, name: "n1", title: "T1", author: "Author A", subjects: ["Fantasy", "Military"], publisher: "Pub X" },
    }),
    book({
      txtId: 2,
      info: { txtId: 2, name: "n2", title: "T2", author: "Author B", subjects: ["Fantasy"], publisher: "Pub X" },
    }),
    book({
      txtId: 3,
      info: { txtId: 3, name: "n3", title: "T3", subjects: [] }, // no author/publisher
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
