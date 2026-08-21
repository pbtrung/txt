import { afterEach, describe, expect, it, vi } from "vitest";

import { RqliteClient } from "../../src/data/rqlite";

const URL = "https://api.example.com/operator/rqlite";
const COLUMNS = [
  "firebase_uid",
  "wrapped_umk",
  "sign_version",
  "sign_algorithm",
  "wrapped_sign_private_key",
  "encrypted_credentials",
];

afterEach(() => vi.unstubAllGlobals());

describe("RqliteClient", () => {
  it("loads the singleton owner through the authenticated operator proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            columns: COLUMNS,
            values: [["owner-uid", [1, 2], 1, "ECDSA-P521-SHA512", [3], [4, 5]]],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(
      new RqliteClient(URL, "admin", "secret").fetchOwnerKeys(signal),
    ).resolves.toEqual({
      uid: "owner-uid",
      wrappedUmk: new Uint8Array([1, 2]),
      signing: {
        version: 1,
        algorithm: "ECDSA-P521-SHA512",
        wrappedPrivateKey: new Uint8Array([3]),
      },
      encryptedCredentials: new Uint8Array([4, 5]),
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${URL}/db/query?level=strong&blob_array`);
    expect(init.headers.Authorization).toBe("Basic YWRtaW46c2VjcmV0");
    expect(init.signal).toBe(signal);
    expect(JSON.parse(init.body)[0][0]).toContain("FROM owner_control");
  });

  it("rejects an unprovisioned or malformed owner row", async () => {
    for (const result of [
      { columns: COLUMNS, values: [] },
      {
        columns: COLUMNS,
        values: [["owner-uid", [], 1, "ECDSA-P521-SHA512", [3], [4]]],
      },
      { error: "no such table: owner_control" },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ results: [result] }),
        }),
      );
      await expect(
        new RqliteClient(URL, "admin", "secret").fetchOwnerKeys(),
      ).rejects.toThrow();
    }
  });

  it("reports an operator proxy failure before parsing the body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(
      new RqliteClient(URL, "admin", "bad").fetchOwnerKeys(),
    ).rejects.toThrow(/401/);
  });
});
