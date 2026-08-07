import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  transact: vi.fn(),
  putObject: vi.fn(async () => undefined),
  idCounter: 0,
  tokenCounter: 0,
}));

function makeEntityProxy(entity: string) {
  return new Proxy(
    {},
    {
      get: (_target, rowId: string) => ({
        update: (attrs: unknown) => ({
          link: (links: unknown) => ({
            op: "update",
            entity,
            id: rowId,
            attrs,
            links,
          }),
        }),
      }),
    },
  );
}

vi.mock("@instantdb/admin", () => ({
  init: () => ({ query: state.query, transact: state.transact }),
  id: () => `id-${state.idCounter++}`,
  tx: {
    txt: makeEntityProxy("txt"),
    txtMetadata: makeEntityProxy("txtMetadata"),
    txtParts: makeEntityProxy("txtParts"),
  },
}));

// Identity crypto: "encrypt"/"decrypt" are no-ops that just hand back the
// buffer they were given. This test suite is about ingest.ts's own
// orchestration (dedup, seq assignment, transact shape, upload-failure
// handling), not round-tripping the real AEAD -- txt/crypto.ts's own
// primitives are exercised for real elsewhere.
vi.mock("../txt/crypto.ts", () => ({
  CryptoEngine: {
    create: async () => ({
      blobDecrypt: (_ikm: unknown, blob: Buffer) => blob,
      blobEncrypt: (_ikm: unknown, data: Buffer) => data,
    }),
  },
}));

vi.mock("../txt/randomToken.ts", () => ({
  generateRandomToken: () => `token-${state.tokenCounter++}`,
  wrapToken: (_crypto: unknown, _key: unknown, token: string) =>
    `wrapped:${token}`,
}));

vi.mock("../txt/r2.ts", () => ({
  R2Client: class {
    async putObject(key: string, body: Buffer): Promise<void> {
      await state.putObject(key, body);
    }
  },
}));

vi.mock("../txt/opf.ts", () => ({
  findOpfSidecar: () => null,
  parseOpfMetadata: () => ({}),
}));

import type { Logger } from "../txt/logger.ts";
import type { ScanCreds } from "../txt/scanCreds.ts";
import { TxtIngester } from "../txt/ingest.ts";

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

const R2_PAYLOAD_B64 = Buffer.from(
  JSON.stringify({
    r2_config: {
      endpoint: "https://example.com",
      region: "auto",
      bucket: "test-bucket",
      read_only_access_key_id: "ro-id",
      read_only_secret_access_key: "ro-secret",
      read_write_access_key_id: "rw-id",
      read_write_secret_access_key: "rw-secret",
    },
  }),
).toString("base64");

function catalogRow(name: string, seq: number) {
  const catalog = Buffer.from(
    JSON.stringify({
      name,
      title: name,
      authors: [],
      subjects: [],
      publishers: [],
    }),
  ).toString("base64");
  return {
    id: `txt-${name}`,
    seq,
    txtKey: "txt-key-blob",
    txtMetadata: [{ catalog }],
  };
}

function mockAdminAndR2(existingRows: unknown[]) {
  state.query
    .mockResolvedValueOnce({ $users: [{ id: "admin-1", umk: "umk-blob" }] })
    .mockResolvedValueOnce({ txt: existingRows })
    .mockResolvedValueOnce({
      credStore: [
        {
          id: "cred-1",
          credStoreKey: "cred-key-blob",
          content: R2_PAYLOAD_B64,
        },
      ],
    });
}

function decodeJson(base64: string): any {
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  state.idCounter = 0;
  state.tokenCounter = 0;
  state.putObject.mockResolvedValue(undefined);
  dir = mkdtempSync(join(tmpdir(), "ingest-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TxtIngester.run", () => {
  it("skips a file whose name is already recorded, without ingesting or failing it", async () => {
    writeFileSync(join(dir, "already.txt"), "hello");
    mockAdminAndR2([catalogRow("already.txt", 1)]);

    const result = await new TxtIngester(creds, log).run({
      srcDir: dir,
      dryRun: false,
    });

    expect(result.skipped).toEqual(["already.txt"]);
    expect(result.ingested).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(state.transact).not.toHaveBeenCalled();
  });

  it("commits exactly one transact() per file with the right shape and incrementing seq", async () => {
    writeFileSync(join(dir, "a.txt"), "first document body");
    writeFileSync(join(dir, "b.txt"), "second document body");
    mockAdminAndR2([]);

    const result = await new TxtIngester(creds, log).run({
      srcDir: dir,
      dryRun: false,
    });

    expect(result.failed).toEqual([]);
    expect(result.ingested.map((d) => d.name)).toEqual(["a.txt", "b.txt"]);
    expect(state.transact).toHaveBeenCalledTimes(2);

    const [firstCallTxs] = state.transact.mock.calls[0]!;
    const [secondCallTxs] = state.transact.mock.calls[1]!;

    const txRow = (txs: any[]) => txs.find((t) => t.entity === "txt");
    const metadataRow = (txs: any[]) =>
      txs.find((t) => t.entity === "txtMetadata");
    const partRows = (txs: any[]) => txs.filter((t) => t.entity === "txtParts");

    expect(txRow(firstCallTxs)).toMatchObject({
      attrs: { seq: 1 },
      links: { owner: "admin-1" },
    });
    expect(txRow(secondCallTxs)).toMatchObject({
      attrs: { seq: 2 },
      links: { owner: "admin-1" },
    });

    const firstTxtId = txRow(firstCallTxs).id;
    expect(metadataRow(firstCallTxs).links).toEqual({
      txt: firstTxtId,
      owner: "admin-1",
    });
    expect(decodeJson(metadataRow(firstCallTxs).attrs.content)).toMatchObject({
      name: "a.txt",
    });
    expect(decodeJson(metadataRow(firstCallTxs).attrs.catalog)).toMatchObject({
      name: "a.txt",
    });

    const parts = partRows(firstCallTxs);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      attrs: { partNum: 1, path: "wrapped:token-1" },
      links: { txt: firstTxtId, owner: "admin-1" },
    });
    expect(parts[0].attrs.partKey).toBe(`${firstTxtId}:1`);
  });

  it("does not transact a file whose part upload fails, and still ingests the rest", async () => {
    writeFileSync(join(dir, "bad.txt"), "will fail to upload");
    writeFileSync(join(dir, "good.txt"), "will upload fine");
    mockAdminAndR2([]);
    state.putObject.mockImplementation(async (key: string) => {
      if (key.includes("token-1")) throw new Error("simulated R2 failure");
    });

    const result = await new TxtIngester(creds, log).run({
      srcDir: dir,
      dryRun: false,
    });

    expect(result.failed.map((f) => f.name)).toEqual(["bad.txt"]);
    expect(result.ingested.map((d) => d.name)).toEqual(["good.txt"]);
    expect(state.transact).toHaveBeenCalledTimes(1);
  });

  it("continues seq from the current max across already-existing documents", async () => {
    writeFileSync(join(dir, "new.txt"), "brand new document");
    mockAdminAndR2([catalogRow("old.txt", 5)]);

    await new TxtIngester(creds, log).run({ srcDir: dir, dryRun: false });

    const [txs] = state.transact.mock.calls[0]!;
    const txRow = txs.find((t: any) => t.entity === "txt");
    expect(txRow.attrs.seq).toBe(6);
  });

  it("dry-run reports part counts without touching InstantDB writes or R2", async () => {
    writeFileSync(join(dir, "preview.txt"), "some content to split");
    state.query
      .mockResolvedValueOnce({ $users: [{ id: "admin-1", umk: "umk-blob" }] })
      .mockResolvedValueOnce({ txt: [] });

    const result = await new TxtIngester(creds, log).run({
      srcDir: dir,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.ingested).toEqual([
      { name: "preview.txt", txtId: "(dry-run)", partCount: 1 },
    ]);
    expect(state.transact).not.toHaveBeenCalled();
    expect(state.putObject).not.toHaveBeenCalled();
  });
});
