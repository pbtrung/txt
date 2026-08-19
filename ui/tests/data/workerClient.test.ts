import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  R2_TICKET_PROOF_VERSION,
  canonicalR2TicketProof,
} from "../../../shared/r2Proof";
import type { FirebaseTokenProvider } from "../../src/auth/firebaseSignIn";
import { WorkerClient, type R2SigningIdentity } from "../../src/data/workerClient";
import { fromBase64 } from "../../src/util/base64";

const UID = "uid-123";
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

function keysResponse(r2Ticket = TICKET) {
  return {
    type: "user",
    uid: UID,
    umk: "dW1r",
    signing: {
      version: 1,
      algorithm: "ECDSA-P521-SHA512",
      private_key: "cHJpdmF0ZQ==",
    },
    cred_store: "Y29udGVudA==",
    r2_ticket: r2Ticket,
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
    bucket: "b",
    region: "auto",
  };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-521" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signing = {
    ticket: TICKET,
    userHandle: USER_HANDLE,
    privateKey: pair.privateKey,
  };
  publicKey = pair.publicKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  signing.ticket = TICKET;
});

describe("WorkerClient.fetchKeys", () => {
  it("validates and returns the wrapped signing material", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => keysResponse(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const signal = new AbortController().signal;
    const result = await new WorkerClient(tokenProvider()).fetchKeys(signal);

    expect(result).toEqual({
      type: "user",
      uid: UID,
      umk: "dW1r",
      signing: {
        version: 1,
        algorithm: "ECDSA-P521-SHA512",
        privateKey: "cHJpdmF0ZQ==",
      },
      credStore: "Y29udGVudA==",
      r2Ticket: TICKET,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/keys");
    expect(init.headers.Authorization).toBe("Bearer idtok");
    expect(init.signal).toBe(signal);
  });

  it("refreshes once after a 401", async () => {
    const provider = tokenProvider(["expired", "fresh"]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => keysResponse(),
      });
    vi.stubGlobal("fetch", fetchMock);

    await new WorkerClient(provider).fetchKeys();

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer expired");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh");
    expect(provider.getIdToken).toHaveBeenLastCalledWith(true, undefined);
  });

  it("reports provisioning and malformed response errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(new WorkerClient(tokenProvider()).fetchKeys()).rejects.toThrow(
      /not provisioned/,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ...keysResponse(), type: "reader" }),
      }),
    );
    await expect(new WorkerClient(tokenProvider()).fetchKeys()).rejects.toThrow(
      /account type/,
    );
  });
});

describe("WorkerClient.fetchR2Token", () => {
  it("signs the paths and parses exactly one credential of each type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => credentialResponse(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WorkerClient(tokenProvider()).fetchR2Token(
      DB_PATH,
      DB_PREFIX,
      signing,
    );

    expect(result.dbPath.accessKeyId).toBe("db_path-ak");
    expect(result.dbPrefix.accessKeyId).toBe("db_prefix-ak");
    expect(result.dbPath.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(result.dbPath.expiration).toBe("2026-12-01T00:00:00.000Z");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/r2-token");
    expect(init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.ticket).toBe(TICKET);
    expect(fromBase64(body.user_handle)).toEqual(USER_HANDLE);
    expect(body.db_path).toBe(DB_PATH);
    expect(body.db_prefix).toBe(DB_PREFIX);
    expect(body.proof.version).toBe(R2_TICKET_PROOF_VERSION);
    expect(fromBase64(body.proof.request_id)).toHaveLength(32);
    expect(fromBase64(body.proof.signature)).toHaveLength(132);

    const canonical = await canonicalR2TicketProof({
      version: R2_TICKET_PROOF_VERSION,
      ticket: TICKET,
      userHandle: USER_HANDLE,
      expiresAt: body.proof.expires_at,
      requestId: fromBase64(body.proof.request_id),
      dbPath: DB_PATH,
      dbPrefix: DB_PREFIX,
    });
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-512" },
        publicKey,
        fromBase64(body.proof.signature),
        canonical,
      ),
    ).resolves.toBe(true);
  });

  it("fetches a replacement ticket after a 401 and rebuilds the proof", async () => {
    const provider = tokenProvider(["idtok"]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => keysResponse("new.header.signature"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => credentialResponse(),
      });
    vi.stubGlobal("fetch", fetchMock);

    const signal = new AbortController().signal;
    await new WorkerClient(provider).fetchR2Token(DB_PATH, DB_PREFIX, signing, signal);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/r2-token",
      "/v1/keys",
      "/v1/r2-token",
    ]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer idtok");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).ticket).toBe(
      "new.header.signature",
    );
    for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBe(signal);
    expect(provider.getIdToken).toHaveBeenCalledTimes(1);
    expect(provider.getIdToken).toHaveBeenCalledWith(false, signal);
  });

  it("rejects missing, duplicate, and unknown credential types", async () => {
    for (const credentials of [
      [credential("db_path")],
      [credential("db_path"), credential("db_path")],
      [credential("db_path"), { ...credential("db_prefix"), type: "bucket" }],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => credentialResponse(credentials as never),
        }),
      );
      await expect(
        new WorkerClient(tokenProvider()).fetchR2Token(DB_PATH, DB_PREFIX, signing),
      ).rejects.toThrow(/credential/);
    }
  });
});

describe("WorkerClient share administration", () => {
  it("creates grants and requests bound object deletion with Firebase", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ grant: "opaque" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerClient(tokenProvider());
    const request = {
      dbPath: DB_PATH,
      dbPrefix: DB_PREFIX,
      sharePrefix: "1".repeat(52),
      sharePath: "2".repeat(52),
      shareId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };

    await expect(client.createShareGrant(request)).resolves.toBe("opaque");
    await expect(client.deleteShare(request)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["/v1/share-grant", "POST"],
      ["/v1/share", "DELETE"],
    ]);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer idtok");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      db_path: request.dbPath,
      db_prefix: request.dbPrefix,
      share_prefix: request.sharePrefix,
      share_path: request.sharePath,
      share_id: request.shareId,
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("retries network failures while creating and deleting shares", async () => {
    vi.useFakeTimers();
    try {
      const failedGrantResponse = {
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new TypeError("network load failed")),
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(failedGrantResponse)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ grant: "retried" }),
        })
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ ok: true, status: 204 });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerClient(tokenProvider());
      const request = {
        dbPath: DB_PATH,
        dbPrefix: DB_PREFIX,
        sharePrefix: "1".repeat(52),
        sharePath: "2".repeat(52),
        shareId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      };

      const create = client.createShareGrant(request);
      const created = expect(create).resolves.toBe("retried");
      await vi.runAllTimersAsync();
      await created;

      const remove = client.deleteShare(request);
      const removed = expect(remove).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      await removed;

      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
