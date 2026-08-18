import { describe, expect, it, vi } from "vitest";
import { R2AuthorizationError, R2Client, R2ConflictError } from "../../src/data/r2";

const CREDENTIAL = {
  accessKeyId: "ak",
  secretAccessKey: "sk",
  sessionToken: "st",
  expiration: "2026-12-01T00:00:00.000Z",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "b",
};

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

vi.mock("aws4fetch", () => ({
  AwsClient: vi.fn().mockImplementation(function () {
    return { fetch: vi.fn() };
  }),
}));

describe("R2Client.getObject", () => {
  it("returns the object's bytes on success", async () => {
    const client = new R2Client(CREDENTIAL);
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = (
      client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
    ).aws.fetch;
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      arrayBuffer: async () => bodyOf(bytes),
    });

    const result = await client.getObject("some/key");

    expect([...(result ?? [])]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acct.r2.cloudflarestorage.com/b/some/key",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("returns null on a 404", async () => {
    const client = new R2Client(CREDENTIAL);
    const fetchMock = (
      client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
    ).aws.fetch;
    fetchMock.mockResolvedValue({ status: 404, ok: false });

    expect(await client.getObject("missing")).toBeNull();
  });

  it("throws on other non-ok statuses", async () => {
    const client = new R2Client(CREDENTIAL);
    const fetchMock = (
      client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
    ).aws.fetch;
    fetchMock.mockResolvedValue({ status: 500, ok: false });

    await expect(client.getObject("key")).rejects.toThrow(/500/);
  });
});

describe("R2Client database operations", () => {
  it("downloads with no-store and preserves the exact ETag", async () => {
    const client = new R2Client(CREDENTIAL);
    const fetchMock = (
      client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
    ).aws.fetch;
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ ETag: '"quoted-etag"' }),
      arrayBuffer: async () => bodyOf(new Uint8Array([4, 5])),
    });

    await expect(client.getDatabase("db-key")).resolves.toEqual({
      bytes: new Uint8Array([4, 5]),
      etag: '"quoted-etag"',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acct.r2.cloudflarestorage.com/b/db-key",
      { cache: "no-store", signal: expect.any(AbortSignal) },
    );
  });

  it("retries when reading a response body fails after fetch resolves", async () => {
    vi.useFakeTimers();
    try {
      const client = new R2Client(CREDENTIAL);
      const fetchMock = (
        client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
      ).aws.fetch;
      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          headers: new Headers({ ETag: '"first"' }),
          arrayBuffer: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          headers: new Headers({ ETag: '"second"' }),
          arrayBuffer: async () => bodyOf(new Uint8Array([6, 7])),
        });

      const download = client.getDatabase("db-key");
      await vi.advanceTimersByTimeAsync(250);

      await expect(download).resolves.toEqual({
        bytes: new Uint8Array([6, 7]),
        etag: '"second"',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a read three times when the network is unavailable", async () => {
    vi.useFakeTimers();
    try {
      const client = new R2Client(CREDENTIAL);
      const fetchMock = (
        client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
      ).aws.fetch;
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

      const download = client.getDatabase("db-key");
      const rejection = expect(download).rejects.toThrow("Failed to fetch");
      await vi.runAllTimersAsync();

      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("conditionally replaces existing and absent databases", async () => {
    const client = new R2Client(CREDENTIAL);
    const fetchMock = (
      client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
    ).aws.fetch;
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ ETag: '"next"' }),
    });

    await expect(
      client.putDatabase("db-key", new Uint8Array([1]), '"current"'),
    ).resolves.toBe('"next"');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      "If-Match": '"current"',
    });

    await client.putDatabase("db-key", new Uint8Array([2]), null);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      "If-None-Match": "*",
    });
  });

  it("retries a conditional upload after a transient fetch failure", async () => {
    vi.useFakeTimers();
    try {
      const client = new R2Client(CREDENTIAL);
      const fetchMock = (
        client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
      ).aws.fetch;
      fetchMock
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          headers: new Headers({ ETag: '"next"' }),
        });

      const upload = client.putDatabase("db-key", new Uint8Array([1]), '"current"');
      await vi.advanceTimersByTimeAsync(250);

      await expect(upload).resolves.toBe('"next"');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1].headers).toEqual({
        "If-Match": '"current"',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns typed conflict and authorization failures", async () => {
    const client = new R2Client(CREDENTIAL);
    const fetchMock = (
      client as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
    ).aws.fetch;
    fetchMock.mockResolvedValueOnce({ status: 412, ok: false });
    await expect(
      client.putDatabase("db-key", new Uint8Array(), '"stale"'),
    ).rejects.toBeInstanceOf(R2ConflictError);

    fetchMock.mockResolvedValueOnce({ status: 403, ok: false });
    await expect(client.getDatabase("db-key")).rejects.toBeInstanceOf(
      R2AuthorizationError,
    );
  });
});
