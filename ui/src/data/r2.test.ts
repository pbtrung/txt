import { describe, expect, it, vi } from "vitest";
import { R2Client } from "./r2";

const CREDENTIAL = {
  accessKeyId: "ak",
  secretAccessKey: "sk",
  sessionToken: "st",
  expiration: "2026-01-01T00:00:00.000Z",
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
