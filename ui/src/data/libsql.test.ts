import { afterEach, describe, expect, it, vi } from "vitest";
import { LibsqlClient } from "./libsql";

function fakePipelineResponse(rows: unknown[][]) {
  return {
    ok: true,
    json: async () => ({ results: [{ response: { result: { rows } } }] }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LibsqlClient", () => {
  it("decodes text, integer, and blob cells", async () => {
    const rows = [
      [{ type: "text", value: "hello" }, { type: "integer", value: "42" }, { type: "blob", base64: "aGk=" }],
    ];
    const fetchMock = vi.fn().mockResolvedValue(fakePipelineResponse(rows));
    vi.stubGlobal("fetch", fetchMock);

    const client = new LibsqlClient("libsql://db-x.aws-us-east-1.turso.io", "token123");
    const result = await client.query("SELECT a, b, c FROM t");

    expect(result).toEqual([["hello", 42, new TextEncoder().encode("hi")]]);
  });

  it("posts to https://.../v2/pipeline with a bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakePipelineResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new LibsqlClient("libsql://db-x.aws-us-east-1.turso.io", "token123");
    await client.query("SELECT 1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://db-x.aws-us-east-1.turso.io/v2/pipeline");
    expect(init.headers.Authorization).toBe("Bearer token123");
  });

  it("encodes blob args as base64 and integer args as decimal strings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakePipelineResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new LibsqlClient("libsql://db-x.aws-us-east-1.turso.io", "token123");
    await client.query("SELECT * FROM t WHERE a = ? AND b = ?", [new Uint8Array([1, 2, 3]), 7]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.requests[0].stmt.args).toEqual([
      { type: "blob", base64: "AQID" },
      { type: "integer", value: "7" },
    ]);
  });

  it("throws when the HTTP request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const client = new LibsqlClient("libsql://db-x.aws-us-east-1.turso.io", "token123");

    await expect(client.query("SELECT 1")).rejects.toThrow(/500/);
  });
});
