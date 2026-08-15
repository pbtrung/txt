import { describe, expect, it } from "vitest";
import { brotliCompress } from "../crypto/brotli";
import { encrypt } from "../crypto/cryptoBlob";
import { toBase32Crockford } from "../util/base32Crockford";
import { loadReaderDocument } from "./readerDocument";
import type { R2Client } from "./r2";
import { ensureSchema } from "./schema";
import { SqliteDatabase } from "./sqlite";

function fakeR2(objects: Record<string, Uint8Array>): R2Client {
  return {
    getObject: async (key: string) => objects[key] ?? null,
  } as unknown as R2Client;
}

async function catalogBlob(catalog: Record<string, unknown>): Promise<Uint8Array> {
  return brotliCompress(new TextEncoder().encode(JSON.stringify(catalog)));
}

describe("loadReaderDocument (real sqlcipher.wasm + real crypto)", () => {
  it("fetches and decrypts a document's content under its own txt_key", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);

    const txtKey = crypto.getRandomValues(new Uint8Array(128));
    const txtPrefix = crypto.getRandomValues(new Uint8Array(32));
    const path = crypto.getRandomValues(new Uint8Array(32));
    const epubBytes = new TextEncoder().encode("fake epub content");
    const encrypted = await encrypt(epubBytes, txtKey);
    const catalog = await catalogBlob({
      name: "dune.epub",
      title: "Dune",
      authors: ["Frank Herbert"],
      subjects: ["Science Fiction", "Adventure"],
      publisher: "Ace",
    });

    db.query(
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
        "VALUES (?, ?, ?, ?, 0, 0)",
      [txtKey, txtPrefix, path, catalog],
    );

    const key = `the-db-prefix/${toBase32Crockford(txtPrefix)}/${toBase32Crockford(path)}`;
    const r2 = fakeR2({ [key]: encrypted });

    const doc = await loadReaderDocument(db, r2, "the-db-prefix", 1);
    db.close();

    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("Dune");
    expect(doc!.authors).toEqual(["Frank Herbert"]);
    expect(doc!.subjects).toEqual(["Science Fiction", "Adventure"]);
    expect(doc!.publisher).toBe("Ace");
    expect(new TextDecoder().decode(doc!.epubBytes)).toBe("fake epub content");
  });

  it("passes through an empty authors/subjects and a null publisher", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);

    const txtKey = crypto.getRandomValues(new Uint8Array(128));
    const txtPrefix = crypto.getRandomValues(new Uint8Array(32));
    const path = crypto.getRandomValues(new Uint8Array(32));
    const encrypted = await encrypt(new TextEncoder().encode("content"), txtKey);
    const catalog = await catalogBlob({
      name: "untitled.epub",
      title: "untitled.epub",
      authors: [],
      subjects: [],
      publisher: null,
    });

    db.query(
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
        "VALUES (?, ?, ?, ?, 0, 0)",
      [txtKey, txtPrefix, path, catalog],
    );
    const key = `the-db-prefix/${toBase32Crockford(txtPrefix)}/${toBase32Crockford(path)}`;
    const r2 = fakeR2({ [key]: encrypted });

    const doc = await loadReaderDocument(db, r2, "the-db-prefix", 1);
    db.close();

    expect(doc!.title).toBe("untitled.epub");
    expect(doc!.authors).toEqual([]);
    expect(doc!.subjects).toEqual([]);
    expect(doc!.publisher).toBeNull();
  });

  it("returns null when the txt row doesn't exist", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);

    expect(await loadReaderDocument(db, fakeR2({}), "the-db-prefix", 999)).toBeNull();
    db.close();
  });

  it("returns null when the R2 content object is missing", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);

    const txtKey = crypto.getRandomValues(new Uint8Array(128));
    const txtPrefix = crypto.getRandomValues(new Uint8Array(32));
    const path = crypto.getRandomValues(new Uint8Array(32));
    const catalog = await catalogBlob({
      name: "x.epub",
      title: "x.epub",
      authors: [],
      subjects: [],
      publisher: null,
    });
    db.query(
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
        "VALUES (?, ?, ?, ?, 0, 0)",
      [txtKey, txtPrefix, path, catalog],
    );

    expect(await loadReaderDocument(db, fakeR2({}), "the-db-prefix", 1)).toBeNull();
    db.close();
  });
});
