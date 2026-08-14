import { describe, expect, it } from "vitest";
import { buildBundleFixture } from "../testUtils/bundleFixture";
import { hotPageKey, parseBundle } from "./bundleFormat";

describe("parseBundle", () => {
  it("parses the header fields", () => {
    const bytes = buildBundleFixture(42, [[1, 42]], []);
    const parsed = parseBundle(bytes);

    expect(parsed.builtAtVersion).toBe(42);
    expect(parsed.pageSize).toBe(32768);
  });

  it("parses the page map", () => {
    const bytes = buildBundleFixture(
      10,
      [
        [1, 10],
        [2, 8],
        [5, 9],
      ],
      [],
    );

    const parsed = parseBundle(bytes);

    expect([...parsed.pageMap.entries()]).toEqual([
      [1, 10],
      [2, 8],
      [5, 9],
    ]);
  });

  it("parses hot page bytes via the index, at the right offsets", () => {
    const page1 = new Uint8Array(32768).fill(0xaa);
    const page2 = new Uint8Array(32768).fill(0xbb);
    const bytes = buildBundleFixture(
      10,
      [
        [1, 10],
        [2, 10],
      ],
      [
        { pageNo: 1, versionCreated: 10, data: page1 },
        { pageNo: 2, versionCreated: 10, data: page2 },
      ],
    );

    const parsed = parseBundle(bytes);

    expect(parsed.hotPageBytes.get(hotPageKey(1, 10))).toEqual(page1);
    expect(parsed.hotPageBytes.get(hotPageKey(2, 10))).toEqual(page2);
  });

  it("handles an empty bundle (no live pages, no hot pages)", () => {
    const bytes = buildBundleFixture(0, [], []);
    const parsed = parseBundle(bytes);

    expect(parsed.pageMap.size).toBe(0);
    expect(parsed.hotPageBytes.size).toBe(0);
  });

  it("rejects a bad magic", () => {
    const bytes = buildBundleFixture(1, [[1, 1]], []);
    bytes.set(new TextEncoder().encode("XXXX"), 0);

    expect(() => parseBundle(bytes)).toThrow(/bad bundle magic/);
  });

  it("rejects a bundle shorter than the header", () => {
    expect(() => parseBundle(new Uint8Array(10))).toThrow(/too short/);
  });
});
