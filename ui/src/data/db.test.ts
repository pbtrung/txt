import type { Client, ResultSet } from "@libsql/core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setVerbose } from "../log";
import { createDb } from "./db";
import type { Creds } from "./creds";

vi.mock("@libsql/client/web", () => ({ createClient: vi.fn() }));

const CREDS = { tursoDatabaseUrl: "libsql://example", tursoAuthToken: "token" } as Creds;

function fakeResultSet(rows: unknown[] = []): ResultSet {
  return {
    rows,
    columns: [],
    columnTypes: [],
    rowsAffected: 0,
    lastInsertRowid: undefined,
    toJSON: () => ({}),
  } as unknown as ResultSet;
}

async function mockClientWith(execute: Client["execute"]) {
  const { createClient } = await import("@libsql/client/web");
  vi.mocked(createClient).mockReturnValue({ execute } as unknown as Client);
}

describe("createDb's request logging", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setVerbose(false);
  });

  it("doesn't log when verbose is off", async () => {
    setVerbose(false);
    await mockClientWith(vi.fn().mockResolvedValue(fakeResultSet()));
    const db = createDb(CREDS);
    await db.execute({ sql: "SELECT 1", args: [] });
    expect(console.log).not.toHaveBeenCalled();
  });

  it("logs the request and its row count when verbose is on", async () => {
    setVerbose(true);
    await mockClientWith(vi.fn().mockResolvedValue(fakeResultSet([{ id: 1 }])));

    const db = createDb(CREDS);
    await db.execute({ sql: "SELECT id FROM users WHERE id = ?", args: [1] });

    expect(console.log).toHaveBeenCalledWith("[verbose]", expect.stringContaining("db.execute: SELECT id FROM users"));
    expect(console.log).toHaveBeenCalledWith("[verbose]", expect.stringContaining("db.execute done"));
  });

  it("logs a failed request instead of swallowing the error", async () => {
    setVerbose(true);
    const err = new Error("boom");
    await mockClientWith(vi.fn().mockRejectedValue(err));

    const db = createDb(CREDS);
    await expect(db.execute({ sql: "SELECT 1", args: [] })).rejects.toThrow("boom");
    expect(console.log).toHaveBeenCalledWith("[verbose]", expect.stringContaining("db.execute failed"), err);
  });

  it("passes non-execute properties through untouched", async () => {
    const close = vi.fn();
    const { createClient } = await import("@libsql/client/web");
    vi.mocked(createClient).mockReturnValue({ execute: vi.fn(), close } as unknown as Client);

    const db = createDb(CREDS);
    db.close();
    expect(close).toHaveBeenCalled();
  });
});
