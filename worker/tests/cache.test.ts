import { describe, expect, it, vi } from "vitest";
import { cacheAccount, checkRateLimit, getCachedAccount, purgeAccount } from "../cache";
import type { Account } from "../ctl";

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
  signVersion: 1,
  signAlgorithm: "ECDSA-P521-SHA512",
  signPublicKey: "c2lnLXB1YmxpYw==",
  signPrivateKey: "c2lnLXByaXZhdGU=",
  dbBindingHash: "YmluZGluZw==",
  credStoreContent: "Y29udGVudA==",
};

describe("account cache", () => {
  it("round-trips a cached account with a 24-hour TTL", async () => {
    const kv = fakeKv();
    await cacheAccount(kv, "uid-123", ACCOUNT);
    expect(await getCachedAccount(kv, "uid-123")).toEqual(ACCOUNT);
    expect(kv.put).toHaveBeenCalledWith("keys:v2:uid-123", expect.any(String), {
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
    expect(kv.delete).toHaveBeenCalledWith("keys:v2:uid-123");
    expect(kv.delete).toHaveBeenCalledWith("keys:uid-123");
  });
});

describe("checkRateLimit", () => {
  it("allows up to 60 key requests per uid per hour", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 60; i++) {
      expect(await checkRateLimit(kv, "uid-123", "keys")).toBe(true);
    }
  });

  it("rejects the 31st R2 token request within the same window", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(kv, "uid-123", "r2-token");
    }
    expect(await checkRateLimit(kv, "uid-123", "r2-token")).toBe(false);
  });

  it("tracks separate uids and endpoints independently", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(kv, "uid-a", "r2-token");
    }
    expect(await checkRateLimit(kv, "uid-a", "r2-token")).toBe(false);
    expect(await checkRateLimit(kv, "uid-a", "keys")).toBe(true);
    expect(await checkRateLimit(kv, "uid-b", "r2-token")).toBe(true);
  });
});
