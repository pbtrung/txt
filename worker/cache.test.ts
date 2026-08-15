import { describe, expect, it, vi } from "vitest";
import { cacheAccount, checkRateLimit, getCachedAccount, purgeAccount } from "./cache";
import type { Account } from "./ctl";

function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
}

const ACCOUNT: Account = {
  type: "user",
  umk: "dW1r",
  credStoreContent: "Y29udGVudA==",
};

describe("account cache", () => {
  it("round-trips a cached account with a 24-hour TTL", async () => {
    const kv = fakeKv();
    await cacheAccount(kv, "uid-123", ACCOUNT);
    expect(await getCachedAccount(kv, "uid-123")).toEqual(ACCOUNT);
    expect(kv.put).toHaveBeenCalledWith("keys:uid-123", expect.any(String), {
      expirationTtl: 24 * 60 * 60,
    });
  });

  it("misses for an uncached uid", async () => {
    const kv = fakeKv();
    expect(await getCachedAccount(kv, "uid-123")).toBeNull();
  });

  it("purge removes a cached account", async () => {
    const kv = fakeKv();
    await cacheAccount(kv, "uid-123", ACCOUNT);
    await purgeAccount(kv, "uid-123");
    expect(await getCachedAccount(kv, "uid-123")).toBeNull();
  });
});

describe("checkRateLimit", () => {
  it("allows up to 20 requests per uid per hour", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 20; i++) {
      expect(await checkRateLimit(kv, "uid-123")).toBe(true);
    }
  });

  it("rejects the 21st request within the same window", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 20; i++) await checkRateLimit(kv, "uid-123");
    expect(await checkRateLimit(kv, "uid-123")).toBe(false);
  });

  it("tracks separate uids independently", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 20; i++) await checkRateLimit(kv, "uid-a");
    expect(await checkRateLimit(kv, "uid-a")).toBe(false);
    expect(await checkRateLimit(kv, "uid-b")).toBe(true);
  });
});
