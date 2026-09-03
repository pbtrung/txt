import { describe, expect, it, vi } from "vitest";
import { R2AuthorizationError, R2Client, R2ConflictError } from "../../src/data/r2";

const CREDENTIAL = { accessKeyId: "ak", secretAccessKey: "sk", sessionToken: "st" };
const ENDPOINT = "https://acct.r2.cloudflarestorage.com";
const BUCKET = "b";

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

function client(): { client: R2Client; fetchMock: ReturnType<typeof vi.fn> } {
  const instance = new R2Client(CREDENTIAL, ENDPOINT, BUCKET);
  const fetchMock = (
    instance as unknown as { aws: { fetch: ReturnType<typeof vi.fn> } }
  ).aws.fetch;
  return { client: instance, fetchMock };
}

describe("R2Client.getObject", () => {
  it("returns the object's bytes on success", async () => {
    const { client: instance, fetchMock } = client();
    const bytes = new Uint8Array([1, 2, 3]);
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      arrayBuffer: async () => bodyOf(bytes),
    });

    const result = await instance.getObject("some/key");

    expect([...(result ?? [])]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acct.r2.cloudflarestorage.com/b/some/key",
      { signal: expect.any(AbortSignal), cache: "no-store" },
    );
  });

  it("returns null on a 404", async () => {
    const { client: instance, fetchMock } = client();
    fetchMock.mockResolvedValue({ status: 404, ok: false });

    expect(await instance.getObject("missing")).toBeNull();
  });

  it("throws on other non-ok statuses", async () => {
    const { client: instance, fetchMock } = client();
    fetchMock.mockResolvedValue({ status: 500, ok: false });

    await expect(instance.getObject("key")).rejects.toThrow(/500/);
  });

  it("returns typed authorization failures", async () => {
    const { client: instance, fetchMock } = client();
    fetchMock.mockResolvedValue({ status: 403, ok: false });

    await expect(instance.getObject("key")).rejects.toBeInstanceOf(
      R2AuthorizationError,
    );
  });

  it("retries a read three times when the network is unavailable", async () => {
    vi.useFakeTimers();
    try {
      const { client: instance, fetchMock } = client();
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

      const download = instance.getObject("key");
      const rejection = expect(download).rejects.toThrow("Failed to fetch");
      await vi.runAllTimersAsync();

      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R2Client.putImmutable", () => {
  it("creates without replacement with non-cacheable binary metadata", async () => {
    const { client: instance, fetchMock } = client();
    fetchMock.mockResolvedValue({ status: 200, ok: true, headers: new Headers() });

    await instance.putImmutable("shared/key", new Uint8Array([1]));

    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      headers: {
        "If-None-Match": "*",
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, no-store",
      },
    });
  });

  it("throws a typed conflict when the object already exists", async () => {
    const { client: instance, fetchMock } = client();
    fetchMock.mockResolvedValue({ status: 412, ok: false });

    await expect(
      instance.putImmutable("shared/key", new Uint8Array([1])),
    ).rejects.toBeInstanceOf(R2ConflictError);
  });

  it("retries after a transient fetch failure", async () => {
    vi.useFakeTimers();
    try {
      const { client: instance, fetchMock } = client();
      fetchMock
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ status: 200, ok: true, headers: new Headers() });

      const upload = instance.putImmutable("shared/key", new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(250);

      await expect(upload).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
