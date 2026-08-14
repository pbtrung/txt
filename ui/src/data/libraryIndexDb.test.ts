import { describe, expect, it } from "vitest";
import { buildSqliteFixture } from "../testUtils/sqliteFixture";
import { loadLibraryBooks } from "./libraryIndexDb";

// Matches txt/library_index.py's SCHEMA_SQL exactly (docs/data_model.md §8.1).
const SCHEMA_SQL = `
  CREATE TABLE doc (txt_id INTEGER PRIMARY KEY, title TEXT NOT NULL, sort_key TEXT);
  CREATE TABLE term (id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, name TEXT NOT NULL);
  CREATE UNIQUE INDEX idx_term_kind_name ON term(kind, name);
  CREATE TABLE doc_term (doc_id INTEGER NOT NULL, kind INTEGER NOT NULL, ord INTEGER NOT NULL,
      term_id INTEGER NOT NULL, PRIMARY KEY (doc_id, kind, ord)) WITHOUT ROWID;
`;

function buildLibraryIndexBytes(rows: string[]): Promise<Uint8Array> {
  return buildSqliteFixture([SCHEMA_SQL, ...rows]);
}

describe("loadLibraryBooks (real sqlcipher.wasm, unkeyed)", () => {
  it("combines doc and doc_term/term into LibraryBook records", async () => {
    const bytes = await buildLibraryIndexBytes([
      "INSERT INTO doc (txt_id, title, sort_key) VALUES (1, 'Dune', 'Dune');",
      "INSERT INTO term (id, kind, name) VALUES (1, 1, 'Frank Herbert'), (2, 2, 'Science Fiction'), (3, 3, 'Ace');",
      "INSERT INTO doc_term (doc_id, kind, ord, term_id) VALUES (1, 1, 0, 1), (1, 2, 0, 2), (1, 3, 0, 3);",
    ]);

    const books = await loadLibraryBooks(bytes);

    expect(books).toEqual([
      { txtId: 1, title: "Dune", sortKey: "Dune", authors: ["Frank Herbert"], subjects: ["Science Fiction"], publisher: "Ace" },
    ]);
  });

  it("preserves author order via doc_term.ord and defaults missing fields", async () => {
    const bytes = await buildLibraryIndexBytes([
      "INSERT INTO doc (txt_id, title, sort_key) VALUES (2, 'Good Omens', NULL);",
      "INSERT INTO term (id, kind, name) VALUES (1, 1, 'Neil Gaiman'), (2, 1, 'Terry Pratchett');",
      "INSERT INTO doc_term (doc_id, kind, ord, term_id) VALUES (2, 1, 0, 2), (2, 1, 1, 1);",
    ]);

    const [book] = await loadLibraryBooks(bytes);

    expect(book.authors).toEqual(["Terry Pratchett", "Neil Gaiman"]);
    expect(book.sortKey).toBeNull();
    expect(book.subjects).toEqual([]);
    expect(book.publisher).toBeNull();
  });

  it("returns an empty list for an empty library", async () => {
    const bytes = await buildLibraryIndexBytes([]);
    expect(await loadLibraryBooks(bytes)).toEqual([]);
  });
});
