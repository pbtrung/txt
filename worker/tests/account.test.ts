import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccount } from "../account";
import { cacheAccount, checkRateLimit, getCachedAccount } from "../cache";
import { lookupAccount } from "../ctl";
import type { Account } from "../ctl";

vi.mock("../ctl");
vi.mock("../cache");

const ENV = {
  CTL_DB_URL: "libsql://ctl-x.aws-us-east-1.turso.io",
  CTL_DB_TOKEN: "ctl-tok",
  KEYS_CACHE: {},
} as unknown as Env;

const ACCOUNT: Account = {
  type: "user",
  umk: "dW1r",
  credStoreContent: "Y29udGVudA==",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(getCachedAccount).mockResolvedValue(null);
});

describe("getAccount", () => {
  it("returns a cached account without checking the rate limit or ctl", async () => {
    vi.mocked(getCachedAccount).mockResolvedValue(ACCOUNT);

    const result = await getAccount(ENV, "uid-123");

    expect(result).toEqual({ status: "ok", account: ACCOUNT });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(lookupAccount).not.toHaveBeenCalled();
  });

  it("returns rate_limited when the limit is exceeded on a cache miss", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);

    const result = await getAccount(ENV, "uid-123");

    expect(result).toEqual({ status: "rate_limited" });
    expect(lookupAccount).not.toHaveBeenCalled();
  });

  it("returns not_provisioned when ctl has no row", async () => {
    vi.mocked(lookupAccount).mockResolvedValue(null);

    const result = await getAccount(ENV, "uid-123");

    expect(result).toEqual({ status: "not_provisioned" });
    expect(cacheAccount).not.toHaveBeenCalled();
  });

  it("returns unavailable when ctl throws", async () => {
    vi.mocked(lookupAccount).mockRejectedValue(new Error("network error"));

    const result = await getAccount(ENV, "uid-123");

    expect(result).toEqual({ status: "unavailable" });
  });

  it("fetches from ctl, caches, and returns ok on success", async () => {
    vi.mocked(lookupAccount).mockResolvedValue(ACCOUNT);

    const result = await getAccount(ENV, "uid-123");

    expect(result).toEqual({ status: "ok", account: ACCOUNT });
    expect(cacheAccount).toHaveBeenCalledWith(ENV.KEYS_CACHE, "uid-123", ACCOUNT);
  });
});
