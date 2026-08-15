import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerClient } from "./workerClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkerClient.fetchKeys", () => {
  it("returns type/umk/credStore on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: "user", umk: "dW1r", cred_store: "Y29udGVudA==" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WorkerClient(
      "https://worker.example",
      "idtok",
    ).fetchKeys();

    expect(result).toEqual({ type: "user", umk: "dW1r", credStore: "Y29udGVudA==" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://worker.example/v1/keys");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer idtok");
  });

  it("throws a specific message on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    await expect(
      new WorkerClient("https://worker.example", "idtok").fetchKeys(),
    ).rejects.toThrow(/not provisioned/);
  });

  it("throws on other non-ok statuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(
      new WorkerClient("https://worker.example", "idtok").fetchKeys(),
    ).rejects.toThrow(/503/);
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

    const result = await new WorkerClient(
      "https://worker.example",
      "idtok",
    ).fetchR2Token("the-db-path", "the-db-prefix");

    expect(result).toEqual({
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sessionToken: "st",
      expiration: "2026-01-01T00:00:00.000Z",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "b",
      region: "auto",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://worker.example/v1/r2-token");
    expect(JSON.parse(init.body)).toEqual({
      db_path: "the-db-path",
      db_prefix: "the-db-prefix",
    });
  });

  it("throws on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));

    await expect(
      new WorkerClient("https://worker.example", "idtok").fetchR2Token("p", "q"),
    ).rejects.toThrow(/400/);
  });
});
