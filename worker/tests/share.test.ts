import { base64url, jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { storagePathBinding } from "../../shared/r2Proof";
import { getAccount } from "../account";
import { verifyFirebaseIdToken } from "../firebaseAuth";
import { handleCreateShareGrant, handleSharedR2Token } from "../share";

vi.mock("../account");
vi.mock("../firebaseAuth");

const ADMIN_UID = "admin-uid";
const DB_PATH = "0".repeat(52);
const DB_PREFIX = "1".repeat(52);
const SHARE_PREFIX = "2".repeat(52);
const SHARE_PATH = "3".repeat(52);
const SHARE_ID = toBase64(new Uint8Array(32).fill(4));
const SECRET = toBase64(new Uint8Array(32).fill(5));
const ENV = {
  ADMIN_UID,
  FIREBASE_PROJECT_ID: "project",
  R2_TICKET_SECRET: SECRET,
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_BUCKET: "bucket",
  R2_REGION: "auto",
  R2_READ_WRITE_ACCESS_KEY_ID: "access",
  R2_READ_WRITE_SECRET_ACCESS_KEY: "secret",
} as unknown as Env;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: ADMIN_UID });
  vi.mocked(getAccount).mockResolvedValue({
    status: "ok",
    account: {
      type: "user",
      umk: "",
      signVersion: 1,
      signAlgorithm: "ECDSA-P521-SHA512",
      signPublicKey: "",
      signPrivateKey: "",
      userHandleHash: toBase64(new Uint8Array(32)),
      dbBindingHash: toBase64(await storagePathBinding(DB_PATH, DB_PREFIX)),
      credStoreContent: "",
    },
  });
});

describe("book-share grants", () => {
  it("lets only ADMIN_UID create a grant for its bound shared path", async () => {
    const response = await handleCreateShareGrant(createRequest(), ENV);
    expect(response.status).toBe(200);
    const { grant } = (await response.json()) as { grant: string };
    const token = await handleSharedR2Token(sharedRequest(grant), ENV);
    expect(token.status).toBe(200);
    const body = (await token.json()) as {
      object_path: string;
      credential: { session_token: string };
    };
    expect(body.object_path).toBe(`${DB_PREFIX}/shared/${SHARE_PREFIX}/${SHARE_PATH}`);
    const jwt = new TextDecoder().decode(
      base64url.decode(body.credential.session_token),
    );
    const payload = (
      await jwtVerify(
        jwt.replace(/^jwt\//, ""),
        new TextEncoder().encode(ENV.R2_READ_WRITE_SECRET_ACCESS_KEY),
      )
    ).payload;
    expect(payload).toMatchObject({
      scope: "object-read-only",
      paths: { objectPaths: [body.object_path], prefixPaths: [] },
    });
  });

  it("rejects a non-admin uid even if Turso calls it admin", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "other-uid" });
    expect((await handleCreateShareGrant(createRequest(), ENV)).status).toBe(403);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("rejects changed storage bindings and modified grants", async () => {
    const changed = createRequest({ db_prefix: "9".repeat(52) });
    expect((await handleCreateShareGrant(changed, ENV)).status).toBe(403);
    const { grant } = (await (
      await handleCreateShareGrant(createRequest(), ENV)
    ).json()) as { grant: string };
    expect(
      (await handleSharedR2Token(sharedRequest(`${grant.slice(0, -1)}x`), ENV)).status,
    ).toBe(401);
  });
});

function createRequest(overrides: Record<string, string> = {}): Request {
  return new Request("https://example/v1/share-grant", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({
      db_path: DB_PATH,
      db_prefix: DB_PREFIX,
      share_prefix: SHARE_PREFIX,
      share_path: SHARE_PATH,
      share_id: SHARE_ID,
      ...overrides,
    }),
  });
}

function sharedRequest(grant: string): Request {
  return new Request("https://example/v1/shared-r2-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant }),
  });
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
