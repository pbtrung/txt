import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseNotFoundError, mintDbToken } from "./turso";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mintDbToken", () => {
  it("returns the minted jwt and requests a scoped, expiring token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ jwt: "minted-jwt" }) });
    vi.stubGlobal("fetch", fetchMock);

    const jwt = await mintDbToken("org-tok", "myorg", "dbpath123");

    expect(jwt).toBe("minted-jwt");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/organizations/myorg/databases/dbpath123/auth/tokens");
    expect(url).toContain("expiration=60m");
    expect(url).toContain("authorization=full-access");
    expect(init.headers.Authorization).toBe("Bearer org-tok");
    expect(init.body).toBe("{}");
  });

  it("throws DatabaseNotFoundError on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(mintDbToken("org-tok", "myorg", "missing-db")).rejects.toBeInstanceOf(DatabaseNotFoundError);
  });

  it("throws a plain error on other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(mintDbToken("org-tok", "myorg", "dbpath123")).rejects.not.toBeInstanceOf(DatabaseNotFoundError);
  });
});
