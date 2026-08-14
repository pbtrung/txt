import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { bytesEqual, readCachedLibraryIndex, writeCachedLibraryIndex } from "./libraryIndexCache";

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("txt-library-index-cache");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
});

describe("libraryIndexCache", () => {
  it("returns null before anything has been cached", async () => {
    expect(await readCachedLibraryIndex()).toBeNull();
  });

  it("round-trips a cached entry", async () => {
    const entry = { builtAtVersion: 3, contentHash: new Uint8Array([1, 2, 3]), bytes: new Uint8Array([9, 8, 7, 6]) };
    await writeCachedLibraryIndex(entry);

    const cached = await readCachedLibraryIndex();
    expect(cached?.builtAtVersion).toBe(3);
    expect([...cached!.contentHash]).toEqual([1, 2, 3]);
    expect([...cached!.bytes]).toEqual([9, 8, 7, 6]);
  });

  it("overwrites the single cache slot on a second write", async () => {
    await writeCachedLibraryIndex({ builtAtVersion: 1, contentHash: new Uint8Array([1]), bytes: new Uint8Array([1]) });
    await writeCachedLibraryIndex({ builtAtVersion: 2, contentHash: new Uint8Array([2]), bytes: new Uint8Array([2]) });

    expect((await readCachedLibraryIndex())?.builtAtVersion).toBe(2);
  });
});

describe("bytesEqual", () => {
  it("compares byte content, not identity", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
