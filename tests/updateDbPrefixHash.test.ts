import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  transact: vi.fn(),
  blobDecrypt: vi.fn(),
}));

vi.mock("@instantdb/admin", () => ({
  init: () => ({ query: state.query, transact: state.transact }),
  tx: {
    txt: new Proxy(
      {},
      {
        get: (_target, id: string) => ({
          update: (attrs: unknown) => ({ op: "update", id, attrs }),
        }),
      },
    ),
  },
}));

vi.mock("../txt/crypto.ts", () => ({
  CryptoEngine: {
    create: async () => ({ blobDecrypt: state.blobDecrypt }),
  },
}));

vi.mock("../txt/randomToken.ts", () => ({
  unwrapToken: (_crypto: unknown, _key: unknown, value: string) => value,
}));

import type { Logger } from "../txt/logger.ts";
import { computePrefixHash } from "../txt/prefixHash.ts";
import type { ScanCreds } from "../txt/scanCreds.ts";
import { DbPrefixHashUpdater } from "../txt/updateDbPrefixHash.ts";

const creds: ScanCreds = {
  instantAppId: "app-1",
  instantAdminToken: "admin-token",
  userRootKey: Buffer.from("root-key"),
};

const log: Logger = {
  verbose: true,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  state.blobDecrypt.mockReturnValue(Buffer.from("decrypted-key"));
});

describe("computePrefixHash", () => {
  it("stores the raw SHA-256 digest as padded Base64", () => {
    expect(computePrefixHash("prefix-1")).toBe(
      "RPzASQKOgy/Q3ZB41hIoIKBjUR+hXpNvZGWhLfCAtLo=",
    );
  });
});

describe("DbPrefixHashUpdater", () => {
  it("backfills missing hashes, repairs mismatches, and skips current rows", async () => {
    state.query
      .mockResolvedValueOnce({
        $users: [{ id: "auth-1", umk: "wrapped-umk" }],
      })
      .mockResolvedValueOnce({
        txt: [
          {
            id: "txt-missing",
            sourceTxtId: 1,
            txtKey: "wrapped-key",
            prefix: "prefix-1",
          },
          {
            id: "txt-current",
            sourceTxtId: 2,
            txtKey: "wrapped-key",
            prefix: "prefix-2",
            prefixHash: computePrefixHash("prefix-2"),
          },
          {
            id: "txt-wrong",
            sourceTxtId: 3,
            txtKey: "wrapped-key",
            prefix: "prefix-3",
            prefixHash: "wrong",
          },
          {
            id: "txt-incomplete",
            sourceTxtId: 4,
            txtKey: "wrapped-key",
          },
        ],
      });

    const result = await new DbPrefixHashUpdater(creds, log).run({
      dryRun: false,
    });

    expect(result).toEqual({
      dryRun: false,
      documentCount: 4,
      updated: 2,
      unchanged: 1,
      skipped: 1,
      failed: 0,
    });
    expect(state.transact).toHaveBeenCalledWith([
      {
        op: "update",
        id: "txt-missing",
        attrs: { prefixHash: computePrefixHash("prefix-1") },
      },
      {
        op: "update",
        id: "txt-wrong",
        attrs: { prefixHash: computePrefixHash("prefix-3") },
      },
    ]);
  });

  it("reports a document failure without writing an unverifiable hash", async () => {
    state.query
      .mockResolvedValueOnce({
        $users: [{ id: "auth-1", umk: "wrapped-umk" }],
      })
      .mockResolvedValueOnce({
        txt: [
          {
            id: "txt-corrupt",
            txtKey: "wrapped-key",
            prefix: "wrapped-prefix",
          },
        ],
      });
    state.blobDecrypt
      .mockReturnValueOnce(Buffer.from("admin-umk"))
      .mockImplementationOnce(() => {
        throw new Error("authentication failed");
      });

    const result = await new DbPrefixHashUpdater(creds, log).run({
      dryRun: false,
    });

    expect(result.failed).toBe(1);
    expect(result.updated).toBe(0);
    expect(state.transact).not.toHaveBeenCalled();
  });
});
