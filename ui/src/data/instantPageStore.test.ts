import type { AwsClient } from "aws4fetch";
import { describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { commitPages, fetchPage } from "./instantPageStore";
import { computeR2Prefix } from "./pagePointer";
import type { R2Config } from "./r2Config";

const r2Config: R2Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-bucket",
  readOnlyAccessKeyId: "ro-id",
  readOnlySecretAccessKey: "ro-secret",
  readWriteAccessKeyId: "rw-id",
  readWriteSecretAccessKey: "rw-secret",
};

// A real in-memory R2 "bucket" (Map<key, bytes>) fronted by a fake AwsClient
// -- avoids spinning up an HTTP server for this test, unlike the CLI's mock
// S3 server, since aws4fetch's client.fetch is itself the only seam needed.
function fakeR2(): { client: AwsClient; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const client = {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const key = decodeURIComponent(url.split("/my-bucket/")[1]);
      if (init?.method === "PUT") {
        store.set(
          key,
          new Uint8Array(
            await new Response(init.body as BodyInit).arrayBuffer(),
          ),
        );
        return new Response(null, { status: 200 });
      }
      const body = store.get(key);
      return body
        ? new Response(body as BodyInit, { status: 200 })
        : new Response("not found", { status: 404 });
    }),
  } as unknown as AwsClient;
  return { client, store };
}

// Stateful fake InstantDB client (queryOnce/transact/storage.uploadFile)
// against a real in-memory store, reducing the REAL @instantdb/react tx
// builder's {__etype, __ops} shape -- same approach this session's CLI
// verification used for @instantdb/admin's tx builder. $files content is
// served back via a data: URL (Node's fetch supports the data: scheme), so
// fetchPage's real fetch(url) call works with no second mock server.
function fakeInstantDb() {
  const store = {
    pages: new Map<string, any>(),
    $files: new Map<string, any>(),
    dbMeta: new Map<string, any>(),
  };
  let fileCounter = 0;
  return {
    store,
    async transact(txs: any[]) {
      for (const t of txs) {
        const coll = (store as any)[t.__etype];
        for (const [op, , id, data] of t.__ops) {
          const row = coll.get(id) ?? { id };
          if (op === "update" || op === "link") Object.assign(row, data);
          coll.set(id, row);
        }
      }
      return { "tx-id": "fake-tx" };
    },
    storage: {
      async uploadFile(path: string, content: Blob) {
        fileCounter++;
        const id = `file-${fileCounter}`;
        const bytes = new Uint8Array(await content.arrayBuffer());
        store.$files.set(id, { id, path, bytes });
        return { data: { id } };
      },
    },
    async queryOnce(q: any) {
      if (q.pages) return { data: { pages: queryPages(store, q.pages) } };
      if (q.dbMeta) {
        const row = store.dbMeta.get(q.dbMeta.$.where.id);
        return { data: { dbMeta: row ? [row] : [] } };
      }
      throw new Error(`fakeInstantDb: unhandled query ${JSON.stringify(q)}`);
    },
  };
}

function queryPages(
  store: ReturnType<typeof fakeInstantDb>["store"],
  spec: any,
) {
  const { where, order, limit } = spec.$;
  let rows = [...store.pages.values()].filter(
    (r) =>
      r.owner === where["owner.id"] &&
      r.pageNo === where.pageNo &&
      r.version <= where.version.$lte,
  );
  rows.sort((a, b) =>
    order.version === "desc" ? b.version - a.version : a.version - b.version,
  );
  rows = rows.slice(0, limit);
  return rows.map((r) => ({
    ...r,
    pointerFile: r.pointerFile
      ? [
          {
            url: `data:application/octet-stream;base64,${Buffer.from(store.$files.get(r.pointerFile).bytes).toString("base64")}`,
          },
        ]
      : [],
  }));
}

const pathKey = new Uint8Array(128).fill(11);
const authId = "auth-xyz";
const ownerId = "users-row-1";
const dbMetaId = "dbmeta-1";
const r2Prefix = computeR2Prefix(authId);

describe("commitPages / fetchPage", () => {
  it("uploads dirty pages, links owners, CAS-bumps dbMeta, and reads them back", async () => {
    const { client, store: r2Store } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = {
      db,
      r2Client: client,
      r2Config,
      pathKey,
      authId,
      r2Prefix,
      ownerId,
    };

    const dirty = new Map([
      [1, new Uint8Array(64).fill(1)],
      [2, new Uint8Array(64).fill(2)],
    ]);
    const result = await commitPages(cfg, dirty, dbMetaId, 0, 2, 64);

    expect(result.newVersion).toBe(1);
    expect(r2Store.size).toBe(2);
    expect([...r2Store.keys()].every((k) => k.startsWith(r2Prefix + "/"))).toBe(
      true,
    );

    const fileRows = [...db.store.$files.values()];
    expect(fileRows).toHaveLength(2);
    expect(fileRows.every((r) => r.owner === ownerId)).toBe(true);
    // The uploaded $files content must be the real encrypted pointer, not
    // a placeholder, and must never be brotli-compressed first (a plain
    // AEAD blob's minimum length is 132 bytes -- see docs/crypto.md).
    expect(fileRows.every((r) => r.bytes.length >= 132)).toBe(true);

    const page2 = await fetchPage(cfg, 2, 1);
    expect(Array.from(page2)).toEqual(Array.from(new Uint8Array(64).fill(2)));
  });

  it("retries the commit if a concurrent writer already advanced currentVersion", async () => {
    const { client } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = {
      db,
      r2Client: client,
      r2Config,
      pathKey,
      authId,
      r2Prefix,
      ownerId,
    };

    // Simulate another writer: bump currentVersion behind this caller's
    // back, and make the FIRST transact() attempt reject (as InstantDB's
    // own CAS permission check would for a stale newData.currentVersion),
    // succeeding only once retryCommit re-reads the real version.
    let transactCalls = 0;
    const realTransact = db.transact.bind(db);
    db.transact = async (txs: any[]) => {
      transactCalls++;
      if (transactCalls === 1) {
        db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 5 });
        throw new Error("Permission denied: dbMeta CAS check failed");
      }
      return realTransact(txs);
    };

    const dirty = new Map([[1, new Uint8Array(64).fill(1)]]);
    const result = await commitPages(cfg, dirty, dbMetaId, 0, 1, 64);

    expect(transactCalls).toBe(2);
    expect(result.newVersion).toBe(6); // re-read currentVersion=5, retried at 5+1
    expect(db.store.dbMeta.get(dbMetaId).currentVersion).toBe(6);
  });

  it("gives up after CAS_MAX_RETRIES consecutive conflicts", async () => {
    const { client } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = {
      db,
      r2Client: client,
      r2Config,
      pathKey,
      authId,
      r2Prefix,
      ownerId,
    };

    let transactCalls = 0;
    db.transact = async () => {
      transactCalls++;
      throw new Error("Permission denied: dbMeta CAS check failed");
    };

    const dirty = new Map([[1, new Uint8Array(64).fill(1)]]);
    await expect(commitPages(cfg, dirty, dbMetaId, 0, 1, 64)).rejects.toThrow(
      "CAS check failed",
    );
    expect(transactCalls).toBe(4); // 1 initial attempt + 3 retries
  });

  it("never brotli-compresses the pointer content before encrypting it", async () => {
    const { client } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = {
      db,
      r2Client: client,
      r2Config,
      pathKey,
      authId,
      r2Prefix,
      ownerId,
    };

    await commitPages(
      cfg,
      new Map([[1, new Uint8Array(64).fill(1)]]),
      dbMetaId,
      0,
      1,
      64,
    );

    const [fileRow] = [...db.store.$files.values()];
    const rawPath = new TextDecoder().decode(
      await blob.decrypt(pathKey, fileRow.bytes, false),
    );
    expect(rawPath).toMatch(new RegExp(`^${r2Prefix}/`));
  });
});
