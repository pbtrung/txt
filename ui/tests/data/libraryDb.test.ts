import { describe, expect, it, vi } from "vitest";
import { brotliCompress } from "../../src/crypto/brotli";
import { ensureSchema } from "../../src/data/schema";
import {
  clearBookmarksMutation,
  clearLastAccessMutation,
  loadLibraryBooks,
} from "../../src/data/libraryDb";
import { SqliteDatabase } from "../../src/data/sqlite";

async function catalogBlob(catalog: Record<string, unknown>): Promise<Uint8Array> {
  return brotliCompress(new TextEncoder().encode(JSON.stringify(catalog)));
}

async function insertTxt(
  db: SqliteDatabase,
  id: number,
  catalog: Record<string, unknown>,
): Promise<void> {
  const blob = await catalogBlob(catalog);
  db.query(
    "INSERT INTO txt (id, txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
      "VALUES (?, x'00', x'00', x'00', ?, 0, 0)",
    [id, blob],
  );
}

describe("loadLibraryBooks (real sqlcipher.wasm)", () => {
  it("reads title/authors/subjects/publisher out of the catalog", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    await insertTxt(db, 1, {
      name: "dune.epub",
      title: "Dune",
      authors: ["Frank Herbert"],
      subjects: ["Science Fiction"],
      publisher: "Ace",
    });

    const [book] = await loadLibraryBooks(db);
    db.close();

    expect(book).toEqual({
      txtId: 1,
      title: "Dune",
      authors: ["Frank Herbert"],
      subjects: ["Science Fiction"],
      publisher: "Ace",
      lastAccessed: 0,
      bookmarkCount: 0,
      lastBookmarked: null,
      latestBookmarkCfi: null,
      bookmarks: [],
    });
  });

  it("includes access and aggregate bookmark metadata", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    await insertTxt(db, 1, { name: "dune.epub", title: "Dune" });
    db.execute("UPDATE txt SET last_accessed = 1234 WHERE id = 1");
    db.execute(
      "INSERT INTO txt_bookmarks (txt_id, cfi, page_number, preview, created_at) VALUES " +
        "(1, 'one', 4, 'First', 2000), (1, 'two', 9, 'Second', 3000)",
    );

    const [book] = await loadLibraryBooks(db);
    db.close();

    expect(book).toMatchObject({
      lastAccessed: 1234,
      bookmarkCount: 2,
      lastBookmarked: 3000,
      latestBookmarkCfi: "two",
      bookmarks: [
        { cfi: "two", pageNumber: 9, createdAt: 3000 },
        { cfi: "one", pageNumber: 4, createdAt: 2000 },
      ],
    });
  });

  it("reads multiple authors and subjects", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    await insertTxt(db, 2, {
      name: "good-omens.epub",
      title: "Good Omens",
      authors: ["Terry Pratchett", "Neil Gaiman"],
      subjects: ["Fantasy", "Humor"],
      publisher: null,
    });

    const [book] = await loadLibraryBooks(db);
    db.close();

    expect(book.authors).toEqual(["Terry Pratchett", "Neil Gaiman"]);
    expect(book.subjects).toEqual(["Fantasy", "Humor"]);
    expect(book.publisher).toBeNull();
  });

  it("falls back to the original filename when there's no opf title", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    await insertTxt(db, 3, {
      name: "untitled.epub",
      title: "untitled.epub",
      authors: [],
      subjects: [],
      publisher: null,
    });

    const [book] = await loadLibraryBooks(db);
    db.close();

    expect(book.title).toBe("untitled.epub");
    expect(book.authors).toEqual([]);
  });

  it("returns an empty list for an empty library", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);

    expect(await loadLibraryBooks(db)).toEqual([]);
    db.close();
  });
});

describe("library activity mutations", () => {
  it("clears access without changing location and removes all book bookmarks", () => {
    const execute = vi.fn();
    const database = { execute } as unknown as SqliteDatabase;

    clearLastAccessMutation(7).apply(database);
    clearBookmarksMutation(7).apply(database);

    expect(execute).toHaveBeenNthCalledWith(
      1,
      "UPDATE txt SET last_accessed = 0 WHERE id = ?",
      [7],
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "DELETE FROM txt_bookmarks WHERE txt_id = ?",
      [7],
    );
  });
});
