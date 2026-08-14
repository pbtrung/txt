import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBundleFixture } from "../testUtils/bundleFixture";
import { toBase64 } from "../util/base64";
import { openBB } from "./bbEngine";

vi.mock("./bbEngine", () => ({ openBB: vi.fn() }));
vi.mock("./pageVersions", () => ({
  readHeadVersion: vi.fn(),
  pinSnapshot: vi.fn(),
  scanLivePages: vi.fn(),
  fetchBundleDelta: vi.fn(),
  fetchPageBytes: vi.fn(),
}));

import { fetchBundleDelta, fetchPageBytes, pinSnapshot, readHeadVersion, scanLivePages } from "./pageVersions";
import { openReaderBB } from "./openReaderBB";

const AA = { query: vi.fn(), execute: vi.fn() };
const DB_MASTER_KEY = new Uint8Array([1, 2, 3, 4]);
const DB_MASTER_KEY_BASE64 = toBase64(DB_MASTER_KEY);

function hotPage(byte: number): Uint8Array {
  return new Uint8Array(32768).fill(byte);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readHeadVersion).mockResolvedValue({ version: 10, pageCount: 2 });
  vi.mocked(pinSnapshot).mockResolvedValue(undefined);
  vi.mocked(fetchPageBytes).mockResolvedValue(new Map());
  vi.mocked(openBB).mockResolvedValue({ query: vi.fn(), execute: vi.fn(), drainDirtyPages: vi.fn(), close: vi.fn() });
});

describe("openReaderBB", () => {
  it("pins the head version before doing anything else", async () => {
    vi.mocked(scanLivePages).mockResolvedValue(new Map());
    await openReaderBB({ aa: AA, dbMasterKeyBase64: DB_MASTER_KEY_BASE64, bundleBytes: null });
    expect(pinSnapshot).toHaveBeenCalledWith(AA, 10);
  });

  it("falls back to a full scan when there is no bundle yet", async () => {
    vi.mocked(scanLivePages).mockResolvedValue(new Map([[1, 5]]));
    vi.mocked(fetchPageBytes).mockResolvedValue(new Map([[1, hotPage(1)]]));

    await openReaderBB({ aa: AA, dbMasterKeyBase64: DB_MASTER_KEY_BASE64, bundleBytes: null });

    expect(fetchBundleDelta).not.toHaveBeenCalled();
    expect(fetchPageBytes).toHaveBeenCalledWith(AA, [[1, 5]]);
    const [key, pages] = vi.mocked(openBB).mock.calls[0];
    expect([...key]).toEqual([...DB_MASTER_KEY]);
    expect(pages.get(1)).toEqual(hotPage(1));
  });

  it("uses a bundle's hot-page bytes directly when its version still matches page_map", async () => {
    const bundleBytes = buildBundleFixture(
      10,
      [[1, 10]],
      [{ pageNo: 1, versionCreated: 10, data: hotPage(9) }],
    );
    vi.mocked(fetchBundleDelta).mockResolvedValue(new Map());

    await openReaderBB({ aa: AA, dbMasterKeyBase64: DB_MASTER_KEY_BASE64, bundleBytes });

    expect(fetchPageBytes).toHaveBeenCalledWith(AA, []);
    const [, pages] = vi.mocked(openBB).mock.calls[0];
    expect(pages.get(1)).toEqual(hotPage(9));
  });

  it("re-fetches a hot page whose cached version was superseded by the AA delta", async () => {
    const bundleBytes = buildBundleFixture(
      10,
      [[1, 10]],
      [{ pageNo: 1, versionCreated: 10, data: hotPage(9) }],
    );
    // The delta says page 1 now has a newer live version -- the bundle's
    // own cached bytes (captured at version 10) are stale for it.
    vi.mocked(fetchBundleDelta).mockResolvedValue(new Map([[1, 20]]));
    vi.mocked(fetchPageBytes).mockResolvedValue(new Map([[1, hotPage(99)]]));

    await openReaderBB({ aa: AA, dbMasterKeyBase64: DB_MASTER_KEY_BASE64, bundleBytes });

    expect(fetchPageBytes).toHaveBeenCalledWith(AA, [[1, 20]]);
    const [, pages] = vi.mocked(openBB).mock.calls[0];
    expect(pages.get(1)).toEqual(hotPage(99));
  });

  it("drops a page the delta marks as removed", async () => {
    const bundleBytes = buildBundleFixture(
      10,
      [
        [1, 10],
        [2, 10],
      ],
      [
        { pageNo: 1, versionCreated: 10, data: hotPage(1) },
        { pageNo: 2, versionCreated: 10, data: hotPage(2) },
      ],
    );
    vi.mocked(fetchBundleDelta).mockResolvedValue(new Map([[2, null]]));

    await openReaderBB({ aa: AA, dbMasterKeyBase64: DB_MASTER_KEY_BASE64, bundleBytes });

    const [, pages] = vi.mocked(openBB).mock.calls[0];
    expect(pages.has(1)).toBe(true);
    expect(pages.has(2)).toBe(false);
  });
});
