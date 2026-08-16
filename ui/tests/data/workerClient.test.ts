import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerClient } from "../../src/data/workerClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkerClient.fetchKeys", () => {
  it("validates the account type and returns the consumed key fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: "user", umk: "dW1r", cred_store: "Y29udGVudA==" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WorkerClient("idtok").fetchKeys();

    expect(result).toEqual({ umk: "dW1r", credStore: "Y29udGVudA==" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/keys");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer idtok");
  });

  it("throws a specific message on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    await expect(new WorkerClient("idtok").fetchKeys()).rejects.toThrow(
      /not provisioned/,
    );
  });

  it("throws on other non-ok statuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(new WorkerClient("idtok").fetchKeys()).rejects.toThrow(/503/);
  });

  it("rejects malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ type: "reader", umk: "value" }),
      }),
    );

    await expect(new WorkerClient("idtok").fetchKeys()).rejects.toThrow(/account type/);
  });
});

describe("WorkerClient.fetchR2Token", () => {
  it("sends db_path/db_prefix and returns the credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_key_id: "ak",
        secret_access_key: "sk",
        session_token: "st",
        expiration: "2026-01-01T00:00:00.000Z",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "b",
        region: "auto",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WorkerClient("idtok").fetchR2Token(
      "the-db-path",
      "the-db-prefix",
    );

    expect(result).toEqual({
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sessionToken: "st",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "b",
      region: "auto",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/r2-token");
    expect(JSON.parse(init.body)).toEqual({
      db_path: "the-db-path",
      db_prefix: "the-db-prefix",
    });
  });

  it("throws on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));

    await expect(new WorkerClient("idtok").fetchR2Token("p", "q")).rejects.toThrow(
      /400/,
    );
  });

  it("rejects incomplete successful credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_key_id: "ak" }),
      }),
    );

    await expect(new WorkerClient("idtok").fetchR2Token("p", "q")).rejects.toThrow(
      /secret_access_key/,
    );
  });
});
