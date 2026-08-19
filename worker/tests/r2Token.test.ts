import { base64url, jwtVerify } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  R2_TICKET_PROOF_VERSION,
  canonicalR2TicketProof,
  storagePathBinding,
} from "../../shared/r2Proof";
import { checkRateLimit } from "../cache";
import type { Account } from "../ctl";
import { handleR2Token } from "../r2Token";
import { issueR2Ticket } from "../r2Ticket";

vi.mock("../cache");

const TICKET_SECRET = toBase64(new Uint8Array(32).fill(7));
const ENV = {
  R2_TICKET_SECRET: TICKET_SECRET,
  R2_ENDPOINT: "https://account123.r2.cloudflarestorage.com",
  R2_BUCKET: "txt-bucket",
  R2_REGION: "auto",
  R2_READ_WRITE_ACCESS_KEY_ID: "parent-access-key",
  R2_READ_WRITE_SECRET_ACCESS_KEY: "parent-secret-key",
  KEYS_CACHE: {},
} as unknown as Env;

const UID = "uid-123";
const DB_PATH = "0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk";
const DB_PREFIX = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const USER_HANDLE = new Uint8Array(32).fill(9);

let privateKey: CryptoKey;
let account: Account;
let ticket: string;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeRequest(body: unknown): Request {
  return new Request("https://worker.example/v1/r2-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function signedBody(
  options: {
    ticket?: string;
    userHandle?: Uint8Array;
    dbPath?: string;
    dbPrefix?: string;
    version?: number;
    expiresAt?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const proofTicket = options.ticket ?? ticket;
  const userHandle = options.userHandle ?? USER_HANDLE;
  const dbPath = options.dbPath ?? DB_PATH;
  const dbPrefix = options.dbPrefix ?? DB_PREFIX;
  const version = options.version ?? R2_TICKET_PROOF_VERSION;
  const expiresAt = options.expiresAt ?? Math.floor(Date.now() / 1000) + 30;
  const requestId = crypto.getRandomValues(new Uint8Array(32));
  const canonical = await canonicalR2TicketProof({
    version,
    ticket: proofTicket,
    userHandle,
    expiresAt,
    requestId,
    dbPath,
    dbPrefix,
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-512" },
    privateKey,
    canonical,
  );
  return {
    ticket: proofTicket,
    user_handle: toBase64(userHandle),
    db_path: dbPath,
    db_prefix: dbPrefix,
    proof: {
      version,
      expires_at: expiresAt,
      request_id: toBase64(requestId),
      signature: toBase64(new Uint8Array(signature)),
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
  const handleHash = await crypto.subtle.digest("SHA-256", USER_HANDLE);
  account = {
    type: "user",
    umk: "dW1r",
    signVersion: 1,
    signAlgorithm: "ECDSA-P521-SHA512",
    signPublicKey: toBase64(publicDer),
    signPrivateKey: "d3JhcHBlZC1wcml2YXRl",
    userHandleHash: toBase64(new Uint8Array(handleHash)),
    dbBindingHash: toBase64(await storagePathBinding(DB_PATH, DB_PREFIX)),
    credStoreContent: "Y29udGVudA==",
  };
});

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  ticket = await issueR2Ticket(account, UID, TICKET_SECRET);
});

describe("handleR2Token", () => {
  it("accepts no Firebase authorization and mints least-privilege credentials", async () => {
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
    expect(body).toMatchObject({
      endpoint: ENV.R2_ENDPOINT,
      bucket: ENV.R2_BUCKET,
      region: ENV.R2_REGION,
    });
    expect(body.credentials.map(({ type }) => type).sort()).toEqual([
      "db_path",
      "db_prefix",
    ]);
    await expectCredentialScopes(body.credentials);
    expect(checkRateLimit).toHaveBeenCalledWith(ENV.KEYS_CACHE, UID, "r2-token");
  });

  it("returns 400 for malformed bodies, proof sizes, and proof expiry", async () => {
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

  it("returns 401 for an invalid ticket", async () => {
    const body = await signedBody({ ticket: `${ticket.slice(0, -1)}x` });
    expect((await handleR2Token(makeRequest(body), ENV)).status).toBe(401);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("rejects changed handles, paths, proof versions, and signatures", async () => {
    const otherHandle = await signedBody({ userHandle: new Uint8Array(32).fill(8) });
    expect((await handleR2Token(makeRequest(otherHandle), ENV)).status).toBe(403);

    const alteredPath = await signedBody();
    alteredPath.db_path = "1".repeat(52);
    expect((await handleR2Token(makeRequest(alteredPath), ENV)).status).toBe(403);

    const wrongVersion = await signedBody({ version: 1 });
    expect((await handleR2Token(makeRequest(wrongVersion), ENV)).status).toBe(403);

    const badSignature = await signedBody();
    const proof = badSignature.proof as Record<string, unknown>;
    const signature = Uint8Array.from(atob(proof.signature as string), (value) =>
      value.charCodeAt(0),
    );
    signature[0] ^= 1;
    proof.signature = toBase64(signature);
    expect((await handleR2Token(makeRequest(badSignature), ENV)).status).toBe(403);
  });

  it("rate limits only after the ticket and proof validate", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);
    expect((await handleR2Token(makeRequest(await signedBody()), ENV)).status).toBe(
      429,
    );
  });
});

async function expectCredentialScopes(
  credentials: Array<{ type: string; session_token: string }>,
): Promise<void> {
  const db = credentials.find(({ type }) => type === "db_path")!;
  const prefix = credentials.find(({ type }) => type === "db_prefix")!;
  expect((await decodeSessionTokenJwt(db.session_token)).payload).toMatchObject({
    scope: "object-read-write",
    paths: { objectPaths: [DB_PATH], prefixPaths: [] },
  });
  expect((await decodeSessionTokenJwt(prefix.session_token)).payload).toMatchObject({
    scope: "object-read-only",
    paths: { objectPaths: [], prefixPaths: [`${DB_PREFIX}/`] },
  });
}
