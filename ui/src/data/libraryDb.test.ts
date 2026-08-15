import { describe, expect, it } from "vitest";
import { brotliCompress } from "../crypto/brotli";
import { ensureSchema } from "./schema";
import { loadLibraryBooks } from "./libraryDb";
import { SqliteDatabase } from "./sqlite";

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
      sortKey: null,
      authors: ["Frank Herbert"],
      subjects: ["Science Fiction"],
      publisher: "Ace",
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
