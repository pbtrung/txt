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

async function metadataBlob(
  name: string,
  metadata: Record<string, unknown>,
): Promise<Uint8Array> {
  return brotliCompress(new TextEncoder().encode(JSON.stringify({ name, metadata })));
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
    const metadata = await metadataBlob("dune.epub", {
      title: "Dune",
      creator: "Frank Herbert",
      subject: ["Science Fiction", "Adventure"],
      publisher: "Ace",
    });

    db.query(
      "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, created_at) " +
        "VALUES (?, ?, ?, ?, 0, 0)",
      [txtKey, txtPrefix, path, metadata],
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

  it("defaults authors/subjects to [] and publisher to null when absent", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);

    const txtKey = crypto.getRandomValues(new Uint8Array(128));
    const txtPrefix = crypto.getRandomValues(new Uint8Array(32));
    const path = crypto.getRandomValues(new Uint8Array(32));
    const encrypted = await encrypt(new TextEncoder().encode("content"), txtKey);
    const metadata = await metadataBlob("untitled.epub", {});

    db.query(
      "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, created_at) " +
        "VALUES (?, ?, ?, ?, 0, 0)",
      [txtKey, txtPrefix, path, metadata],
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
    const metadata = await metadataBlob("x.epub", {});
    db.query(
      "INSERT INTO txt (txt_key, txt_prefix, path, metadata, last_accessed, created_at) " +
        "VALUES (?, ?, ?, ?, 0, 0)",
      [txtKey, txtPrefix, path, metadata],
    );

    expect(await loadReaderDocument(db, fakeR2({}), "the-db-prefix", 1)).toBeNull();
    db.close();
  });
});
