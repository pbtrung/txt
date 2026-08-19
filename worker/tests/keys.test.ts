import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccount } from "../account";
import { verifyFirebaseIdToken } from "../firebaseAuth";
import { handleKeys } from "../keys";
import { verifyR2Ticket } from "../r2Ticket";

vi.mock("../firebaseAuth");
vi.mock("../account");

const TICKET_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
  FIREBASE_PROJECT_ID: "proj",
  ADMIN_UID: "admin-uid",
  R2_TICKET_SECRET: TICKET_SECRET,
} as unknown as Env;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

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

  it("returns encrypted keys plus a signed account ticket on success", async () => {
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
        userHandleHash: toBase64(new Uint8Array(32).fill(1)),
        dbBindingHash: toBase64(new Uint8Array(64).fill(2)),
        credStoreContent: "Y29udGVudA==",
      },
    });

    const resp = await handleKeys(makeRequest("good"), ENV);

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
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
    const ticket = await verifyR2Ticket(body.r2_ticket as string, TICKET_SECRET);
    expect(ticket?.subject).toBe("uid-123");
    expect(ticket?.ticketId).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(
      Uint8Array.from(atob(ticket!.ticketId), (value) => value.charCodeAt(0)),
    ).toHaveLength(32);
  });

  it("returns 503 when the ticket secret is invalid", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: {
        type: "user",
        umk: "dW1r",
        signVersion: 1,
        signAlgorithm: "ECDSA-P521-SHA512",
        signPublicKey: "cHVi",
        signPrivateKey: "cHJpdg==",
        userHandleHash: toBase64(new Uint8Array(32)),
        dbBindingHash: toBase64(new Uint8Array(64)),
        credStoreContent: "Y3JlZA==",
      },
    });
    const badEnv = { ...ENV, R2_TICKET_SECRET: "c2hvcnQ=" } as Env;
    expect((await handleKeys(makeRequest("good"), badEnv)).status).toBe(503);
  });

  it("ignores a Turso role change when deriving administrator access", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "uid-123" });
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: {
        type: "admin",
        umk: "dW1r",
        signVersion: 1,
        signAlgorithm: "ECDSA-P521-SHA512",
        signPublicKey: "cHVi",
        signPrivateKey: "cHJpdg==",
        userHandleHash: toBase64(new Uint8Array(32)),
        dbBindingHash: toBase64(new Uint8Array(64)),
        credStoreContent: "Y3JlZA==",
      },
    });

    const body = (await (await handleKeys(makeRequest("good"), ENV)).json()) as {
      type: string;
      r2_ticket: string;
    };
    expect(body.type).toBe("user");
    expect((await verifyR2Ticket(body.r2_ticket, TICKET_SECRET))?.accountType).toBe(
      "user",
    );
  });
});
