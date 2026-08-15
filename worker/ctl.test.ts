import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupAccount } from "./ctl";

function textCell(value: string) {
  return { type: "text", value };
}

function blobCell(base64: string) {
  return { type: "blob", base64 };
}

function nullCell() {
  return { type: "null" };
}

function pipelineResponse(rows: unknown[][]) {
  return { results: [{ response: { result: { rows } } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupAccount", () => {
  it("returns the matching account's type, umk, and cred_store content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        pipelineResponse([
          [
            textCell("user"),
            blobCell("dW1r"),
            nullCell(),
            nullCell(),
            blobCell("Y29udGVudA=="),
          ],
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupAccount(
      "libsql://ctl-x.aws-us-east-1.turso.io",
      "tok",
      "uid-123",
    );

    expect(result).toEqual({
      type: "user",
      umk: "dW1r",
      credStoreContent: "Y29udGVudA==",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ctl-x.aws-us-east-1.turso.io/v2/pipeline");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("returns the admin account's type too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          pipelineResponse([
            [
              textCell("admin"),
              blobCell("dW1r"),
              blobCell("cHVia2V5"),
              blobCell("cHJpdmtleQ=="),
              blobCell("Y29udGVudA=="),
            ],
          ]),
      }),
    );

    const result = await lookupAccount(
      "libsql://ctl-x.aws-us-east-1.turso.io",
      "tok",
      "admin-uid",
    );

    expect(result).toEqual({
      type: "admin",
      umk: "dW1r",
      credStoreContent: "Y29udGVudA==",
    });
  });

  it("returns null when ctl has no row for this uid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => pipelineResponse([]) }),
    );

    const result = await lookupAccount(
      "libsql://ctl-x.aws-us-east-1.turso.io",
      "tok",
      "unknown-uid",
    );

    expect(result).toBeNull();
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(
      lookupAccount("libsql://ctl-x.aws-us-east-1.turso.io", "tok", "uid-123"),
    ).rejects.toThrow(/500/);
  });

  it("throws if umk is not a blob cell", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          pipelineResponse([
            [
              textCell("user"),
              textCell("not-a-blob"),
              nullCell(),
              nullCell(),
              blobCell("Y29udGVudA=="),
            ],
          ]),
      }),
    );

    await expect(
      lookupAccount("libsql://ctl-x.aws-us-east-1.turso.io", "tok", "uid-123"),
    ).rejects.toThrow(/blob/);
  });
});
