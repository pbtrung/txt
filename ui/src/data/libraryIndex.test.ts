import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { brotliCompress } from "../crypto/brotli";
import { encrypt } from "../crypto/cryptoBlob";
import type { CellValue } from "./libsql";
import { loadLibraryIndex } from "./libraryIndex";
import { writeCachedLibraryIndex } from "./libraryIndexCache";
import type { R2 } from "./r2";
import type { Aa } from "./session";

class FakeAa implements Aa {
  constructor(private readonly rows: CellValue[][]) {}
  async query(): Promise<CellValue[][]> {
    return this.rows;
  }
}

class FakeR2 implements R2 {
  public requestedKeys: string[] = [];
  constructor(private readonly objects: Record<string, Uint8Array>) {}
  async getObject(key: string): Promise<Uint8Array> {
    this.requestedKeys.push(key);
    const obj = this.objects[key];
    if (!obj) throw new Error(`no such object: ${key}`);
    return obj;
  }
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("txt-library-index-cache");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
});

describe("loadLibraryIndex", () => {
  it("returns null when the account has no library index yet", async () => {
    const result = await loadLibraryIndex(new FakeAa([]), randomBytes(128), "prefix123", new FakeR2({}));
    expect(result).toBeNull();
  });

  it("fetches, decrypts, and decompresses on a cold cache", async () => {
    const umk = randomBytes(128);
    const libIdxKey = randomBytes(128);
    const sqliteBytes = new TextEncoder().encode("pretend this is a sqlite file");
    const encryptedObject = await encrypt(await brotliCompress(sqliteBytes), libIdxKey);

    const aa = new FakeAa([
      [await encrypt(new TextEncoder().encode("obj-key"), umk), await encrypt(libIdxKey, umk), 5, randomBytes(16)],
    ]);
    const r2 = new FakeR2({ "prefix123/i/obj-key": encryptedObject });

    const result = await loadLibraryIndex(aa, umk, "prefix123", r2);
    expect(new TextDecoder().decode(result!)).toBe("pretend this is a sqlite file");
    expect(r2.requestedKeys).toEqual(["prefix123/i/obj-key"]);
  });

  it("skips the GET when the cache already matches built_at_version and content_hash", async () => {
    const umk = randomBytes(128);
    const libIdxKey = randomBytes(128);
    const contentHash = randomBytes(16);
    const cachedBytes = new TextEncoder().encode("cached copy");
    await writeCachedLibraryIndex({ builtAtVersion: 9, contentHash, bytes: cachedBytes });

    const aa = new FakeAa([
      [await encrypt(new TextEncoder().encode("obj-key"), umk), await encrypt(libIdxKey, umk), 9, contentHash],
    ]);
    const r2 = new FakeR2({});

    const result = await loadLibraryIndex(aa, umk, "prefix123", r2);
    expect(new TextDecoder().decode(result!)).toBe("cached copy");
    expect(r2.requestedKeys).toEqual([]);
  });
});
