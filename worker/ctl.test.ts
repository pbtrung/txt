import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupUser } from "./ctl";

function pipelineResponse(rows: string[][]) {
  return { results: [{ response: { result: { rows: rows.map((row) => row.map((value) => ({ value }))) } } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupUser", () => {
  it("returns the matching user's db_path and type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => pipelineResponse([["dbpath123", "user"]]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupUser("libsql://ctl-x.aws-us-east-1.turso.io", "tok", "uid-123");

    expect(result).toEqual({ dbPath: "dbpath123", type: "user" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ctl-x.aws-us-east-1.turso.io/v2/pipeline");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("returns the admin account's type too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => pipelineResponse([["adminpath", "admin"]]) }));

    const result = await lookupUser("libsql://ctl-x.aws-us-east-1.turso.io", "tok", "admin-uid");

    expect(result).toEqual({ dbPath: "adminpath", type: "admin" });
  });

  it("returns null when ctl has no row for this uid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => pipelineResponse([]) }));

    const result = await lookupUser("libsql://ctl-x.aws-us-east-1.turso.io", "tok", "unknown-uid");

    expect(result).toBeNull();
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(lookupUser("libsql://ctl-x.aws-us-east-1.turso.io", "tok", "uid-123")).rejects.toThrow(/500/);
  });
});
