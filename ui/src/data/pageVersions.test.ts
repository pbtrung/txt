import { describe, expect, it } from "vitest";
import type { CellValue } from "./libsql";
import { fetchBundleDelta, fetchPageBytes, pinSnapshot, readHeadVersion, scanLivePages } from "./pageVersions";
import type { Aa } from "./session";

class FakeAa implements Aa {
  public calls: Array<{ sql: string; args: CellValue[] }> = [];
  constructor(private readonly rowsBySql: Array<[string, CellValue[][]]>) {}

  async query(sql: string, args: CellValue[] = []): Promise<CellValue[][]> {
    this.calls.push({ sql, args });
    const match = this.rowsBySql.find(([needle]) => sql.includes(needle));
    return match ? match[1] : [];
  }

  async execute(sql: string, args: CellValue[] = []): Promise<void> {
    this.calls.push({ sql, args });
  }
}

describe("readHeadVersion", () => {
  it("reads head_version from meta and page_count from versions", async () => {
    const aa = new FakeAa([
      ["FROM meta", [[7]]],
      ["FROM versions", [[42]]],
    ]);

    expect(await readHeadVersion(aa)).toEqual({ version: 7, pageCount: 42 });
  });

  it("throws when meta has no row", async () => {
    await expect(readHeadVersion(new FakeAa([]))).rejects.toThrow(/meta row missing/);
  });

  it("defaults page_count to 0 if versions has no matching row", async () => {
    const aa = new FakeAa([["FROM meta", [[1]]]]);
    expect(await readHeadVersion(aa)).toEqual({ version: 1, pageCount: 0 });
  });
});

describe("pinSnapshot", () => {
  it("inserts a snapshots row pinning the given version", async () => {
    const aa = new FakeAa([]);
    await pinSnapshot(aa, 7);

    expect(aa.calls).toHaveLength(1);
    expect(aa.calls[0].sql).toMatch(/INSERT INTO snapshots/);
    expect(aa.calls[0].args[1]).toBe(7);
  });
});

describe("scanLivePages", () => {
  it("paginates until a short page comes back", async () => {
    let call = 0;
    const aa: Aa = {
      query: async () => {
        call++;
        if (call === 1) return Array.from({ length: 2 }, (_, i) => [i + 1, 100]);
        return [];
      },
      execute: async () => {},
    };
    const map = await scanLivePages(aa);
    expect([...map.entries()]).toEqual([
      [1, 100],
      [2, 100],
    ]);
  });
});

describe("fetchBundleDelta", () => {
  it("adds pages with a newer live version_created", async () => {
    const aa = new FakeAa([["version_created > ?", [[5, 200]]]]);
    const delta = await fetchBundleDelta(aa, 100, 250);
    expect(delta.get(5)).toBe(200);
  });

  it("marks a page for removal when it was deleted without a newer version", async () => {
    const aa = new FakeAa([["SELECT DISTINCT page_no", [[9]]]]);
    const delta = await fetchBundleDelta(aa, 100, 250);
    expect(delta.get(9)).toBeNull();
  });

  it("prefers the added entry over marking a page removed when both match", async () => {
    class BothAa implements Aa {
      async query(sql: string): Promise<CellValue[][]> {
        if (sql.includes("version_created > ?")) return [[9, 210]];
        if (sql.includes("version_deleted > ?")) return [[9]];
        return [];
      }
      async execute(): Promise<void> {}
    }
    const delta = await fetchBundleDelta(new BothAa(), 100, 250);
    expect(delta.get(9)).toBe(210);
  });
});

describe("fetchPageBytes", () => {
  it("fetches exact (page_no, version_created) pairs", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const aa = new FakeAa([["FROM page_versions", [[5, data]]]]);

    const result = await fetchPageBytes(aa, [[5, 100]]);

    expect(result.get(5)).toBe(data);
    expect(aa.calls[0].args).toEqual([5, 100]);
  });

  it("batches large requests", async () => {
    const aa = new FakeAa([]);
    const pairs: Array<[number, number]> = Array.from({ length: 150 }, (_, i) => [i, 1]);

    await fetchPageBytes(aa, pairs);

    expect(aa.calls).toHaveLength(2);
    expect(aa.calls[0].args).toHaveLength(200);
    expect(aa.calls[1].args).toHaveLength(100);
  });
});
