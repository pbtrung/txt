import { base64url, jwtVerify } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalR2Proof, storagePathBinding } from "../../shared/r2Proof";
import { getAccount } from "../account";
import type { Account } from "../ctl";
import { verifyFirebaseIdToken } from "../firebaseAuth";
import { handleR2Token } from "../r2Token";

vi.mock("../firebaseAuth");
vi.mock("../account");

const ENV = {
  FIREBASE_PROJECT_ID: "proj",
  R2_ENDPOINT: "https://account123.r2.cloudflarestorage.com",
  R2_BUCKET: "txt-bucket",
  R2_REGION: "auto",
  R2_READ_WRITE_ACCESS_KEY_ID: "parent-access-key",
  R2_READ_WRITE_SECRET_ACCESS_KEY: "parent-secret-key",
} as unknown as Env;

const UID = "uid-123";
const ID_TOKEN = "header.payload.signature";
const DB_PATH = "0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk";
const DB_PREFIX = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

let privateKey: CryptoKey;
let account: Account;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeRequest(body: unknown, idToken = ID_TOKEN): Request {
  return new Request("https://worker.example/v1/r2-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function signedBody(
  options: {
    dbPath?: string;
    dbPrefix?: string;
    idToken?: string;
    version?: number;
    expiresAt?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const dbPath = options.dbPath ?? DB_PATH;
  const dbPrefix = options.dbPrefix ?? DB_PREFIX;
  const idToken = options.idToken ?? ID_TOKEN;
  const version = options.version ?? 1;
  const expiresAt = options.expiresAt ?? Math.floor(Date.now() / 1000) + 30;
  const requestId = crypto.getRandomValues(new Uint8Array(32));
  const canonical = await canonicalR2Proof({
    version,
    uid: UID,
    firebaseIdToken: idToken,
    expiresAt,
    requestId,
    dbPath,
    dbPrefix,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-512" }, privateKey, canonical),
  );
  return {
    db_path: dbPath,
    db_prefix: dbPrefix,
    proof: {
      version,
      expires_at: expiresAt,
      request_id: toBase64(requestId),
      signature: toBase64(signature),
    },
  };
}

async function decodeSessionTokenJwt(
  sessionToken: string,
): Promise<{ payload: Record<string, unknown> }> {
  const decoded = new TextDecoder().decode(base64url.decode(sessionToken));
  const jwt = decoded.replace(/^jwt\//, "");
  return jwtVerify(jwt, new TextEncoder().encode(ENV.R2_READ_WRITE_SECRET_ACCESS_KEY));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-521" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const publicDer = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  account = {
    type: "user",
    umk: "dW1r",
    signVersion: 1,
    signAlgorithm: "ECDSA-P521-SHA512",
    signPublicKey: toBase64(publicDer),
    signPrivateKey: "d3JhcHBlZC1wcml2YXRl",
    dbBindingHash: toBase64(await storagePathBinding(DB_PATH, DB_PREFIX)),
    credStoreContent: "Y29udGVudA==",
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: UID });
  vi.mocked(getAccount).mockResolvedValue({ status: "ok", account });
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

  it("returns account lookup failures before parsing a proof", async () => {
    vi.mocked(getAccount).mockResolvedValueOnce({ status: "rate_limited" });
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(429);

    vi.mocked(getAccount).mockResolvedValueOnce({ status: "not_provisioned" });
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(403);

    vi.mocked(getAccount).mockResolvedValueOnce({ status: "unavailable" });
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(503);
  });

  it("rejects malformed paths, proof sizes, and expiry with 400", async () => {
    expect((await handleR2Token(makeRequest({}), ENV)).status).toBe(400);

    const expired = await signedBody({
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    expect((await handleR2Token(makeRequest(expired), ENV)).status).toBe(400);

    const malformed = await signedBody();
    (malformed.proof as Record<string, unknown>).signature = toBase64(
      new Uint8Array(131),
    );
    expect((await handleR2Token(makeRequest(malformed), ENV)).status).toBe(400);
  });

  it("mints separate exact-object write and prefix read credentials", async () => {
    const response = await handleR2Token(makeRequest(await signedBody()), ENV);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      credentials: Array<{
        type: "db_path" | "db_prefix";
        access_key_id: string;
        session_token: string;
        expiration: string;
      }>;
      endpoint: string;
      bucket: string;
      region: string;
    };

    expect(body.endpoint).toBe(ENV.R2_ENDPOINT);
    expect(body.bucket).toBe(ENV.R2_BUCKET);
    expect(body.region).toBe(ENV.R2_REGION);
    expect(body.credentials.map(({ type }) => type).sort()).toEqual([
      "db_path",
      "db_prefix",
    ]);
    const dbCredential = body.credentials.find(({ type }) => type === "db_path")!;
    const prefixCredential = body.credentials.find(({ type }) => type === "db_prefix")!;
    expect(dbCredential.access_key_id).toBe(ENV.R2_READ_WRITE_ACCESS_KEY_ID);
    expect(new Date(dbCredential.expiration).getTime()).toBeGreaterThan(Date.now());

    const dbJwt = await decodeSessionTokenJwt(dbCredential.session_token);
    expect(dbJwt.payload.scope).toBe("object-read-write");
    expect(dbJwt.payload.paths).toEqual({
      objectPaths: [DB_PATH],
      prefixPaths: [],
    });

    const prefixJwt = await decodeSessionTokenJwt(prefixCredential.session_token);
    expect(prefixJwt.payload.scope).toBe("object-read-only");
    expect(prefixJwt.payload.paths).toEqual({
      objectPaths: [],
      prefixPaths: [`${DB_PREFIX}/`],
    });
  });

  it("gives an admin the same least-privilege credential pair", async () => {
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: { ...account, type: "admin" },
    });
    const response = await handleR2Token(makeRequest(await signedBody()), ENV);
    const body = (await response.json()) as { credentials: unknown[] };
    expect(response.status).toBe(200);
    expect(body.credentials).toHaveLength(2);
  });

  it("rejects altered paths, bearer tokens, versions, and signatures", async () => {
    const alteredPath = await signedBody();
    alteredPath.db_path = "1".repeat(52);
    expect((await handleR2Token(makeRequest(alteredPath), ENV)).status).toBe(403);

    const otherTokenProof = await signedBody();
    expect(
      (await handleR2Token(makeRequest(otherTokenProof, "different.token"), ENV))
        .status,
    ).toBe(403);

    const wrongVersion = await signedBody({ version: 2 });
    expect((await handleR2Token(makeRequest(wrongVersion), ENV)).status).toBe(403);

    const badSignature = await signedBody();
    const proof = badSignature.proof as Record<string, unknown>;
    const signature = Uint8Array.from(atob(proof.signature as string), (character) =>
      character.charCodeAt(0),
    );
    signature[0] ^= 1;
    proof.signature = toBase64(signature);
    expect((await handleR2Token(makeRequest(badSignature), ENV)).status).toBe(403);
  });

  it("rejects a valid signature when the stored path binding differs", async () => {
    vi.mocked(getAccount).mockResolvedValue({
      status: "ok",
      account: { ...account, dbBindingHash: toBase64(new Uint8Array(64)) },
    });
    expect((await handleR2Token(makeRequest(await signedBody()), ENV)).status).toBe(
      403,
    );
  });
});
