import { base64url, jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccount } from "./account";
import { verifyFirebaseIdToken } from "./firebaseAuth";
import { handleR2Token } from "./r2Token";

vi.mock("./firebaseAuth");
vi.mock("./account");

const ENV = {
  FIREBASE_PROJECT_ID: "proj",
  R2_ENDPOINT: "https://account123.r2.cloudflarestorage.com",
  R2_BUCKET: "txt-bucket",
  R2_REGION: "auto",
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

async function decodeSessionTokenJwt(
  sessionToken: string,
): Promise<{ payload: Record<string, unknown> }> {
  const decoded = new TextDecoder().decode(base64url.decode(sessionToken));
  const jwt = decoded.replace(/^jwt\//, "");
  return jwtVerify(jwt, new TextEncoder().encode(ENV.R2_READ_WRITE_SECRET_ACCESS_KEY));
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("handleR2Token", () => {
  it("returns 401 when no bearer token is present", async () => {
    const request = new Request("https://worker.example/v1/r2-token", {
      method: "POST",
      body: "{}",
    });
    expect((await handleR2Token(request, ENV)).status).toBe(401);
  });

  it("returns 401 when the id token fails verification", async () => {
    vi.mocked(verifyFirebaseIdToken).mockRejectedValue(new Error("bad token"));
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({ status: "rate_limited" });
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(429);
  });

  it("returns 403 when not provisioned", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({ status: "not_provisioned" });
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(403);
  });

  it("returns 400 for a non-admin account with no db_path/db_prefix", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: { type: "user", umk: "dW1r", credStoreContent: "Y29udGVudA==" },
    });
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(400);
  });

  it("mints a read-only credential scoped to db_path and db_prefix", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: { type: "user", umk: "dW1r", credStoreContent: "Y29udGVudA==" },
    });

    const resp = await handleR2Token(
      makeRequest({ db_path: "the-db-path", db_prefix: "the-db-prefix" }),
      ENV,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      access_key_id: string;
      secret_access_key: string;
      session_token: string;
      expiration: string;
      endpoint: string;
      bucket: string;
      region: string;
    };

    expect(body.access_key_id).toBe("parent-access-key");
    expect(typeof body.secret_access_key).toBe("string");
    expect(new Date(body.expiration).getTime()).toBeGreaterThan(Date.now());
    expect(body.endpoint).toBe(ENV.R2_ENDPOINT);
    expect(body.bucket).toBe(ENV.R2_BUCKET);
    expect(body.region).toBe(ENV.R2_REGION);

    const { payload } = await decodeSessionTokenJwt(body.session_token);
    expect(payload.bucket).toBe("txt-bucket");
    expect(payload.scope).toBe("object-read-only");
    expect(payload.paths).toEqual({
      objectPaths: ["the-db-path"],
      prefixPaths: ["the-db-prefix/"],
    });
  });

  it("mints a bucket-wide read-write credential for an admin account", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "admin-uid" });
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: { type: "admin", umk: "dW1r", credStoreContent: "Y29udGVudA==" },
    });

    const resp = await handleR2Token(makeRequest({}), ENV);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      session_token: string;
      endpoint: string;
      bucket: string;
      region: string;
    };

    expect(body.endpoint).toBe(ENV.R2_ENDPOINT);
    expect(body.bucket).toBe(ENV.R2_BUCKET);
    expect(body.region).toBe(ENV.R2_REGION);

    const { payload } = await decodeSessionTokenJwt(body.session_token);
    expect(payload.scope).toBe("object-read-write");
    expect(payload.paths).toBeUndefined();
  });

  it("signs both admin and user credentials from the same parent key", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "admin-uid" });
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: { type: "admin", umk: "dW1r", credStoreContent: "Y29udGVudA==" },
    });

    const resp = await handleR2Token(makeRequest({}), ENV);
    const body = (await resp.json()) as { access_key_id: string };
    expect(body.access_key_id).toBe(ENV.R2_READ_WRITE_ACCESS_KEY_ID);
  });
});
