import { base64url, jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheAccount, getCachedAccount } from "./cache";
import { lookupUser } from "./ctl";
import { verifyFirebaseIdToken } from "./firebaseAuth";
import { handleR2Token } from "./r2Token";

vi.mock("./firebaseAuth");
vi.mock("./ctl");
vi.mock("./cache");

const ENV = {
  FIREBASE_PROJECT_ID: "proj",
  CTL_DB_URL: "libsql://ctl-x.aws-us-east-1.turso.io",
  CTL_DB_TOKEN: "ctl-tok",
  DB_TOKEN_CACHE: {},
  R2_ENDPOINT: "https://account123.r2.cloudflarestorage.com",
  R2_BUCKET: "txt-bucket",
  R2_READ_WRITE_ACCESS_KEY_ID: "parent-access-key",
  R2_READ_WRITE_SECRET_ACCESS_KEY: "parent-secret-key",
} as unknown as Env;

function makeRequest(body: unknown, idToken = "good"): Request {
  return new Request("https://worker.example/v1/r2-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
}

async function decodeSessionTokenJwt(sessionToken: string): Promise<{ payload: Record<string, unknown> }> {
  const decoded = new TextDecoder().decode(base64url.decode(sessionToken));
  const jwt = decoded.replace(/^jwt\//, "");
  return jwtVerify(jwt, new TextEncoder().encode(ENV.R2_READ_WRITE_SECRET_ACCESS_KEY));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCachedAccount).mockResolvedValue(null);
});

describe("handleR2Token", () => {
  it("returns 401 when no bearer token is present", async () => {
    const request = new Request("https://worker.example/v1/r2-token", { method: "POST", body: "{}" });
    expect((await handleR2Token(request, ENV)).status).toBe(401);
  });

  it("returns 401 when the id token fails verification", async () => {
    vi.mocked(verifyFirebaseIdToken).mockRejectedValue(new Error("bad token"));
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(401);
  });

  it("returns 403 when ctl has no row for this uid", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(lookupUser).mockResolvedValue(null);
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(403);
  });

  it("returns 400 for a non-admin account with no db_prefix", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(lookupUser).mockResolvedValue({ dbPath: "dbpath123", type: "user" });
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(400);
  });

  it("mints a read-only credential scoped to the user's own db_prefix", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(lookupUser).mockResolvedValue({ dbPath: "dbpath123", type: "user" });

    const resp = await handleR2Token(makeRequest({ db_prefix: "abc123prefix" }), ENV);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { access_key_id: string; secret_access_key: string; session_token: string; expires_at_ms: number };

    expect(body.access_key_id).toBe("parent-access-key");
    expect(typeof body.secret_access_key).toBe("string");
    expect(body.expires_at_ms).toBeGreaterThan(Date.now());

    const { payload } = await decodeSessionTokenJwt(body.session_token);
    expect(payload.bucket).toBe("txt-bucket");
    expect(payload.scope).toBe("object-read-only");
    expect(payload.paths).toEqual({ prefixPaths: ["abc123prefix/"] });
  });

  it("mints a bucket-wide read-write credential for an admin account", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "admin-uid" });
    vi.mocked(lookupUser).mockResolvedValue({ dbPath: "adminpath", type: "admin" });

    const resp = await handleR2Token(makeRequest({}), ENV);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { session_token: string };

    const { payload } = await decodeSessionTokenJwt(body.session_token);
    expect(payload.scope).toBe("object-read-write");
    expect(payload.paths).toBeUndefined();
  });

  it("caches the resolved account and skips ctl on a later call", async () => {
    vi.mocked(getCachedAccount).mockResolvedValue({ dbPath: "dbpath123", type: "user" });
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });

    const resp = await handleR2Token(makeRequest({ db_prefix: "abc123prefix" }), ENV);

    expect(resp.status).toBe(200);
    expect(lookupUser).not.toHaveBeenCalled();
    expect(cacheAccount).not.toHaveBeenCalled();
  });
});
