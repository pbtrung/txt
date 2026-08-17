import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccount } from "../account";
import { verifyFirebaseIdToken } from "../firebaseAuth";
import { handleKeys } from "../keys";

vi.mock("../firebaseAuth");
vi.mock("../account");

const ENV = { FIREBASE_PROJECT_ID: "proj" } as unknown as Env;

function makeRequest(idToken?: string): Request {
  const headers = idToken ? { Authorization: `Bearer ${idToken}` } : {};
  return new Request("https://worker.example/v1/keys", { method: "POST", headers });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("handleKeys", () => {
  it("returns 401 when no bearer token is present", async () => {
    const resp = await handleKeys(makeRequest(), ENV);
    expect(resp.status).toBe(401);
  });

  it("returns 401 when the id token fails verification", async () => {
    vi.mocked(verifyFirebaseIdToken).mockRejectedValue(new Error("bad token"));
    const resp = await handleKeys(makeRequest("bad"), ENV);
    expect(resp.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({ status: "rate_limited" });
    const resp = await handleKeys(makeRequest("good"), ENV);
    expect(resp.status).toBe(429);
  });

  it("returns 403 when not provisioned", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({ status: "not_provisioned" });
    const resp = await handleKeys(makeRequest("good"), ENV);
    expect(resp.status).toBe(403);
  });

  it("returns 503 when ctl is unavailable", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({ status: "unavailable" });
    const resp = await handleKeys(makeRequest("good"), ENV);
    expect(resp.status).toBe(503);
  });

  it("returns type/umk/cred_store on success", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: {
        type: "user",
        umk: "dW1r",
        signVersion: 1,
        signAlgorithm: "ECDSA-P521-SHA512",
        signPublicKey: "c2lnLXB1YmxpYw==",
        signPrivateKey: "c2lnLXByaXZhdGU=",
        dbBindingHash: "YmluZGluZw==",
        credStoreContent: "Y29udGVudA==",
      },
    });

    const resp = await handleKeys(makeRequest("good"), ENV);

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      type: "user",
      uid: "uid-123",
      umk: "dW1r",
      signing: {
        version: 1,
        algorithm: "ECDSA-P521-SHA512",
        private_key: "c2lnLXByaXZhdGU=",
      },
      cred_store: "Y29udGVudA==",
    });
  });
});
