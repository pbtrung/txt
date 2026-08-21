import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FirebaseTokenProvider } from "../../src/auth/firebaseSignIn";
import { ApiClient, type R2SigningIdentity } from "../../src/data/apiClient";
import {
  R2_TICKET_PROOF_VERSION,
  canonicalR2TicketProof,
} from "../../src/data/r2Proof";
import { fromBase64 } from "../../src/util/base64";

const API = "https://api.example.com";
const UID = "owner-uid";
const DB_PATH = "0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk";
const DB_PREFIX = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const USER_HANDLE = new Uint8Array(32).fill(7);
const TICKET = "header.payload.signature";

let signing: R2SigningIdentity;
let publicKey: CryptoKey;

function tokenProvider(tokens = ["idtok"]): FirebaseTokenProvider {
  let index = 0;
  return {
    getIdToken: vi.fn(async (forceRefresh = false) => {
      if (forceRefresh) index = Math.min(index + 1, tokens.length - 1);
      return tokens[index];
    }),
  };
}

function credential(type: "db_path" | "db_prefix") {
  return {
    type,
    access_key_id: `${type}-ak`,
    secret_access_key: `${type}-sk`,
    session_token: `${type}-st`,
    expiration: "2026-12-01T00:00:00.000Z",
  };
}

function credentialResponse(
  credentials = [credential("db_path"), credential("db_prefix")],
) {
  return {
    credentials,
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "bucket",
    region: "auto",
  };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-521" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signing = { ticket: TICKET, userHandle: USER_HANDLE, privateKey: pair.privateKey };
  publicKey = pair.publicKey;
});

beforeEach(() => {
  signing.ticket = TICKET;
});

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient owner ticket", () => {
  it("uses the API origin and returns only the singleton owner ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ uid: UID, r2_ticket: TICKET, umk: "ignored" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(
      new ApiClient(tokenProvider(), `${API}/`).fetchOwnerTicket(signal),
    ).resolves.toEqual({ uid: UID, ticket: TICKET });
    expect(fetchMock).toHaveBeenCalledWith(
      `${API}/v1/keys`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer idtok" },
        signal,
      }),
    );
  });

  it("refreshes Firebase authentication once after a 401", async () => {
    const provider = tokenProvider(["expired", "fresh"]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ uid: UID, r2_ticket: TICKET }),
        }),
    );

    await new ApiClient(provider, API).fetchOwnerTicket();

    expect(provider.getIdToken).toHaveBeenNthCalledWith(1, false, undefined);
    expect(provider.getIdToken).toHaveBeenNthCalledWith(2, true, undefined);
  });
});

describe("ApiClient R2 credentials", () => {
  it("signs the owner paths and parses one credential of each type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => credentialResponse(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ApiClient(tokenProvider(), API).fetchR2Token(
      DB_PATH,
      DB_PREFIX,
      signing,
    );

    expect(result.dbPath.accessKeyId).toBe("db_path-ak");
    expect(result.dbPrefix.accessKeyId).toBe("db_prefix-ak");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/v1/r2-token`);
    const body = JSON.parse(init.body);
    expect(body.proof.version).toBe(R2_TICKET_PROOF_VERSION);
    await verifyProof(body.proof);
  });

  it("replaces an expired ticket and rebuilds the request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ uid: UID, r2_ticket: "new.ticket.value" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => credentialResponse(),
      });
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient(tokenProvider(), API).fetchR2Token(DB_PATH, DB_PREFIX, signing);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${API}/v1/r2-token`,
      `${API}/v1/keys`,
      `${API}/v1/r2-token`,
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).ticket).toBe("new.ticket.value");
  });

  it("rejects missing or duplicate credential types", async () => {
    for (const credentials of [
      [credential("db_path")],
      [credential("db_path"), credential("db_path")],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => credentialResponse(credentials),
        }),
      );
      await expect(
        new ApiClient(tokenProvider(), API).fetchR2Token(DB_PATH, DB_PREFIX, signing),
      ).rejects.toThrow(/credential/);
    }
  });
});

describe("ApiClient shares", () => {
  it("registers paths and deletes by capability ID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ registered: true, grant: "grant-envelope" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient(tokenProvider(), API);
    const request = {
      dbPath: DB_PATH,
      dbPrefix: DB_PREFIX,
      sharePrefix: "1".repeat(52),
      sharePath: "2".repeat(52),
      shareId: "A".repeat(43),
    };

    await expect(client.registerShare(request)).resolves.toBe("grant-envelope");
    await client.deleteShare(request);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`${API}/v1/shares`, "POST"],
      [`${API}/v1/shares`, "DELETE"],
    ]);
    const expectedBody = {
      db_path: DB_PATH,
      db_prefix: DB_PREFIX,
      share_prefix: request.sharePrefix,
      share_path: request.sharePath,
      share_id: request.shareId,
    };
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expectedBody);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expectedBody);
  });
});

async function verifyProof(proof: Record<string, string | number>) {
  const canonical = await canonicalR2TicketProof({
    version: R2_TICKET_PROOF_VERSION,
    ticket: TICKET,
    userHandle: USER_HANDLE,
    expiresAt: proof.expires_at as number,
    requestId: fromBase64(proof.request_id as string),
    dbPath: DB_PATH,
    dbPrefix: DB_PREFIX,
  });
  await expect(
    crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-512" },
      publicKey,
      fromBase64(proof.signature as string),
      canonical,
    ),
  ).resolves.toBe(true);
}
