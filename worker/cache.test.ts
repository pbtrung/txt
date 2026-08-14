import { describe, expect, it, vi } from "vitest";
import { cacheDbPath, cacheToken, checkRateLimit, getCachedDbPath, getCachedToken } from "./cache";

function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace;
}

describe("token cache", () => {
  it("round-trips a cached token with a 55-minute TTL", async () => {
    const kv = fakeKv();
    await cacheToken(kv, "uid-123", { dbToken: "jwt", dbUrl: "libsql://x" });
    expect(await getCachedToken(kv, "uid-123")).toEqual({ dbToken: "jwt", dbUrl: "libsql://x" });
    expect(kv.put).toHaveBeenCalledWith("token:uid-123", expect.any(String), { expirationTtl: 55 * 60 });
  });

  it("misses for an uncached uid", async () => {
    const kv = fakeKv();
    expect(await getCachedToken(kv, "uid-123")).toBeNull();
  });
});

describe("db_path cache", () => {
  it("round-trips a cached db_path with a 24-hour TTL", async () => {
    const kv = fakeKv();
    await cacheDbPath(kv, "uid-123", "dbpath123");
    expect(await getCachedDbPath(kv, "uid-123")).toBe("dbpath123");
    expect(kv.put).toHaveBeenCalledWith("user:uid-123", "dbpath123", { expirationTtl: 24 * 60 * 60 });
  });
});

describe("checkRateLimit", () => {
  it("allows up to 10 requests per uid per hour", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 10; i++) {
      expect(await checkRateLimit(kv, "uid-123")).toBe(true);
    }
  });

  it("rejects the 11th request within the same window", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 10; i++) await checkRateLimit(kv, "uid-123");
    expect(await checkRateLimit(kv, "uid-123")).toBe(false);
  });

  it("tracks separate uids independently", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 10; i++) await checkRateLimit(kv, "uid-a");
    expect(await checkRateLimit(kv, "uid-a")).toBe(false);
    expect(await checkRateLimit(kv, "uid-b")).toBe(true);
  });
});
