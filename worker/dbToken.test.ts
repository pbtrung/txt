import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheAccount, cacheToken, checkRateLimit, getCachedAccount, getCachedToken } from "./cache";
import { lookupUser } from "./ctl";
import { handleDbToken } from "./dbToken";
import { verifyFirebaseIdToken } from "./firebaseAuth";
import { DatabaseNotFoundError, mintDbToken } from "./turso";

vi.mock("./firebaseAuth");
vi.mock("./ctl");
vi.mock("./turso");
vi.mock("./cache");

const ENV = {
  FIREBASE_PROJECT_ID: "proj",
  CTL_DB_URL: "libsql://ctl-x.aws-us-east-1.turso.io",
  CTL_DB_TOKEN: "ctl-tok",
  TURSO_ORG_TOKEN: "org-tok",
  TURSO_ORG: "x",
  DB_TOKEN_CACHE: {},
} as unknown as Env;

function makeRequest(idToken?: string): Request {
  const headers = idToken ? { Authorization: `Bearer ${idToken}` } : {};
  return new Request("https://worker.example/v1/db-token", { method: "POST", headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(getCachedToken).mockResolvedValue(null);
  vi.mocked(getCachedAccount).mockResolvedValue(null);
});

describe("handleDbToken", () => {
  it("returns 401 when no bearer token is present", async () => {
    const resp = await handleDbToken(makeRequest(), ENV);
    expect(resp.status).toBe(401);
  });

  it("returns 401 when the id token fails verification", async () => {
    vi.mocked(verifyFirebaseIdToken).mockRejectedValue(new Error("bad token"));
    const resp = await handleDbToken(makeRequest("bad"), ENV);
    expect(resp.status).toBe(401);
  });

  it("returns a cached token without touching ctl/Turso at all", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getCachedToken).mockResolvedValue({ dbToken: "cached-jwt", dbUrl: "libsql://cached" });

    const resp = await handleDbToken(makeRequest("good"), ENV);

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ db_token: "cached-jwt", db_url: "libsql://cached" });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(lookupUser).not.toHaveBeenCalled();
    expect(mintDbToken).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(checkRateLimit).mockResolvedValue(false);
    const resp = await handleDbToken(makeRequest("good"), ENV);
    expect(resp.status).toBe(429);
    expect(lookupUser).not.toHaveBeenCalled();
  });

  it("returns 403 when ctl has no row for this uid", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(lookupUser).mockResolvedValue(null);
    const resp = await handleDbToken(makeRequest("good"), ENV);
    expect(resp.status).toBe(403);
  });

  it("returns 503 when the user's database doesn't exist yet", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(lookupUser).mockResolvedValue({ dbPath: "dbpath123", type: "user" });
    vi.mocked(mintDbToken).mockRejectedValue(new DatabaseNotFoundError("dbpath123"));
    const resp = await handleDbToken(makeRequest("good"), ENV);
    expect(resp.status).toBe(503);
  });

  it("returns 503 when ctl itself is unavailable", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(lookupUser).mockRejectedValue(new Error("network error"));
    const resp = await handleDbToken(makeRequest("good"), ENV);
    expect(resp.status).toBe(503);
  });

  it("mints fresh, caches both the account and the token, and returns 200 on success", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(lookupUser).mockResolvedValue({ dbPath: "dbpath123", type: "user" });
    vi.mocked(mintDbToken).mockResolvedValue("minted-jwt");

    const resp = await handleDbToken(makeRequest("good"), ENV);

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      db_token: "minted-jwt",
      db_url: "libsql://dbpath123-x.aws-us-east-1.turso.io",
    });
    expect(cacheAccount).toHaveBeenCalledWith(ENV.DB_TOKEN_CACHE, "uid-123", { dbPath: "dbpath123", type: "user" });
    expect(cacheToken).toHaveBeenCalledWith(ENV.DB_TOKEN_CACHE, "uid-123", {
      dbToken: "minted-jwt",
      dbUrl: "libsql://dbpath123-x.aws-us-east-1.turso.io",
    });
  });

  it("skips the ctl lookup when the account is already cached", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getCachedAccount).mockResolvedValue({ dbPath: "cached-dbpath", type: "user" });
    vi.mocked(mintDbToken).mockResolvedValue("minted-jwt");

    const resp = await handleDbToken(makeRequest("good"), ENV);

    expect(resp.status).toBe(200);
    expect(lookupUser).not.toHaveBeenCalled();
    expect(cacheAccount).not.toHaveBeenCalled();
  });
});
