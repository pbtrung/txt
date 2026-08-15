import { describe, expect, it } from "vitest";
import { brotliCompress } from "../crypto/brotli";
import { ensureSchema } from "./schema";
import { loadLibraryBooks } from "./libraryDb";
import { SqliteDatabase } from "./sqlite";

async function metadataBlob(
  name: string,
  metadata: Record<string, unknown>,
): Promise<Uint8Array> {
  return brotliCompress(new TextEncoder().encode(JSON.stringify({ name, metadata })));
}

async function insertTxt(
  db: SqliteDatabase,
  id: number,
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const blob = await metadataBlob(name, metadata);
  db.query(
    "INSERT INTO txt (id, txt_key, txt_prefix, path, metadata, last_accessed, created_at) " +
      "VALUES (?, x'00', x'00', x'00', ?, 0, 0)",
    [id, blob],
  );
}

describe("loadLibraryBooks (real sqlcipher.wasm)", () => {
  it("reads title/authors/subjects/publisher out of plain-string opf fields", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    await insertTxt(db, 1, "dune.epub", {
      title: "Dune",
      creator: "Frank Herbert",
      subject: "Science Fiction",
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

  it("normalizes repeated tags and attributed {text, ...} fields", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    await insertTxt(db, 2, "good-omens.epub", {
      title: "Good Omens",
      creator: [
        { text: "Terry Pratchett", role: "aut" },
        { text: "Neil Gaiman", role: "aut" },
      ],
      subject: ["Fantasy", "Humor"],
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
    await insertTxt(db, 3, "untitled.epub", {});

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
