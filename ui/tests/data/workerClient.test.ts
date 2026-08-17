import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalR2Proof } from "../../../shared/r2Proof";
import type { FirebaseTokenProvider } from "../../src/auth/firebaseSignIn";
import { WorkerClient, type R2SigningIdentity } from "../../src/data/workerClient";
import { fromBase64 } from "../../src/util/base64";

const UID = "uid-123";
const DB_PATH = "0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk";
const DB_PREFIX = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

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

function keysResponse() {
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
  signing = { uid: UID, version: 1, privateKey: pair.privateKey };
  publicKey = pair.publicKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkerClient.fetchKeys", () => {
  it("validates and returns the wrapped signing material", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => keysResponse(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WorkerClient(tokenProvider()).fetchKeys();

    expect(result).toEqual({
      uid: UID,
      umk: "dW1r",
      signing: {
        version: 1,
        algorithm: "ECDSA-P521-SHA512",
        privateKey: "cHJpdmF0ZQ==",
      },
      credStore: "Y29udGVudA==",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/keys");
    expect(init.headers.Authorization).toBe("Bearer idtok");
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
    expect(provider.getIdToken).toHaveBeenLastCalledWith(true);
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
    expect(init.headers.Authorization).toBe("Bearer idtok");
    const body = JSON.parse(init.body);
    expect(body.db_path).toBe(DB_PATH);
    expect(body.db_prefix).toBe(DB_PREFIX);
    expect(body.proof.version).toBe(1);
    expect(fromBase64(body.proof.request_id)).toHaveLength(32);
    expect(fromBase64(body.proof.signature)).toHaveLength(132);

    const canonical = await canonicalR2Proof({
      version: 1,
      uid: UID,
      firebaseIdToken: "idtok",
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

  it("rebuilds the proof with the refreshed token after a 401", async () => {
    const provider = tokenProvider(["expired", "fresh"]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => credentialResponse(),
      });
    vi.stubGlobal("fetch", fetchMock);

    await new WorkerClient(provider).fetchR2Token(DB_PATH, DB_PREFIX, signing);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer expired");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh");
    expect(fetchMock.mock.calls[0][1].body).not.toBe(fetchMock.mock.calls[1][1].body);
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
