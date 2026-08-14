import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupUser } from "./ctl";
import { handleDbToken } from "./dbToken";
import { verifyFirebaseIdToken } from "./firebaseAuth";
import { DatabaseNotFoundError, mintDbToken } from "./turso";

vi.mock("./firebaseAuth");
vi.mock("./ctl");
vi.mock("./turso");

const ENV: Env = {
  FIREBASE_PROJECT_ID: "proj",
  CTL_DB_URL: "libsql://ctl-x.aws-us-east-1.turso.io",
  CTL_DB_TOKEN: "ctl-tok",
  TURSO_ORG_TOKEN: "org-tok",
  TURSO_ORG: "x",
};

function makeRequest(idToken?: string): Request {
  const headers = idToken ? { Authorization: `Bearer ${idToken}` } : {};
  return new Request("https://worker.example/v1/db-token", { method: "POST", headers });
}

beforeEach(() => {
  vi.resetAllMocks();
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

  it("returns 200 with db_token/db_url on success", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(lookupUser).mockResolvedValue({ dbPath: "dbpath123", type: "user" });
    vi.mocked(mintDbToken).mockResolvedValue("minted-jwt");
    const resp = await handleDbToken(makeRequest("good"), ENV);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ db_token: "minted-jwt", db_url: "libsql://dbpath123-x.aws-us-east-1.turso.io" });
  });
});
