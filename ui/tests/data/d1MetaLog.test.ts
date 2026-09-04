import { afterEach, describe, expect, it, vi } from "vitest";

import { logD1QueryMeta } from "../../src/data/d1MetaLog";

function responseWithHeader(value: string | null): Response {
  const headers = new Headers();
  if (value !== null) headers.set("X-D1-Meta", value);
  return new Response(null, { headers });
}

describe("logD1QueryMeta", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does nothing when the header is absent", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logD1QueryMeta(responseWithHeader(null));
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing for an empty query list", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logD1QueryMeta(responseWithHeader("[]"));
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing for a malformed header instead of throwing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => logD1QueryMeta(responseWithHeader("not json"))).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a count and the parsed queries for a non-empty list", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
    const queries = [
      { sql: "SELECT 1", rows_read: 1, rows_written: 0 },
      { sql: "SELECT 2", rows_read: 2, rows_written: 0 },
    ];
    logD1QueryMeta(responseWithHeader(JSON.stringify(queries)));
    expect(log).toHaveBeenCalledWith("D1 query meta (2):");
    expect(table).toHaveBeenCalledWith(queries);
  });
});
