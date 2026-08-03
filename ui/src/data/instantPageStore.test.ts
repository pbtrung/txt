import type { AwsClient } from "aws4fetch";
import { describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { commitPages, fetchPage, fetchPagesBatch } from "./instantPageStore";
import { computeR2Prefix } from "./pagePointer";
import type { R2Config } from "./r2Config";

const CROCKFORD_BASE32_RE = /^[0-9abcdefghjkmnpqrstvwxyz]+$/;

const r2Config: R2Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-bucket",
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

// Stateful fake InstantDB client (queryOnce/transact) against a real
// in-memory store, reducing the REAL @instantdb/react tx builder's
// {__etype, __ops} shape -- same approach this session's CLI verification
// used for @instantdb/admin's tx builder. No $files/storage.uploadFile --
// pages.path is a plain field on the row itself now, so a commit is just one
// transact() away from readable, no separate upload call to fake.
function fakeInstantDb() {
  const store = {
    pages: new Map<string, any>(),
    dbMeta: new Map<string, any>(),
  };
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
    async queryOnce(q: any) {
      if (q.pages) return queryPages(store, q.pages);
      if (q.dbMeta) {
        const row = store.dbMeta.get(q.dbMeta.$.where.id);
        return { data: { dbMeta: row ? [row] : [] } };
      }
      throw new Error(`fakeInstantDb: unhandled query ${JSON.stringify(q)}`);
    },
  };
}

// Supports both fetchPage's single-pageNo query (order by version desc,
// limit 1) and fetchPagesBatch's own pageNo: {$in: [...]} + order by
// pageKey asc + cursor pagination. Real queryOnce() resolves with
// {data: {...}, pageInfo: {...}} as *siblings* (confirmed against
// @instantdb/core's own queryOnce() type) -- pageInfo is never nested
// inside data.
function queryPages(
  store: ReturnType<typeof fakeInstantDb>["store"],
  spec: any,
) {
  const { where, order, limit, after } = spec.$;
  let rows = [...store.pages.values()].filter((r) => {
    if (r.owner !== where["owner.id"]) return false;
    if (where.pageNo !== undefined) {
      if (
        typeof where.pageNo === "object" &&
        where.pageNo !== null &&
        "$in" in where.pageNo
      ) {
        if (!where.pageNo.$in.includes(r.pageNo)) return false;
      } else if (r.pageNo !== where.pageNo) {
        return false;
      }
    }
    if (where.version?.$lte !== undefined && r.version > where.version.$lte) {
      return false;
    }
    return true;
  });
  const paginated = order?.pageKey === "asc";
  if (paginated) {
    rows.sort((a, b) =>
      a.pageKey < b.pageKey ? -1 : a.pageKey > b.pageKey ? 1 : 0,
    );
  } else if (order?.version) {
    rows.sort((a, b) =>
      order.version === "desc" ? b.version - a.version : a.version - b.version,
    );
  }
  if (after !== undefined) rows = rows.filter((r) => r.pageKey > after);
  const hasNextPage = limit !== undefined && rows.length > limit;
  if (limit !== undefined) rows = rows.slice(0, limit);
  const endCursor = rows.length > 0 ? rows[rows.length - 1].pageKey : after;
  return {
    data: { pages: rows },
    pageInfo: paginated ? { pages: { hasNextPage, endCursor } } : undefined,
  };
}

const pathKey = new Uint8Array(128).fill(11);
const authId = "auth-xyz";
const dbMetaId = "dbmeta-1";
const r2Prefix = computeR2Prefix(authId);

describe("commitPages / fetchPage", () => {
  it("uploads dirty pages, links owners, CAS-bumps dbMeta, and reads them back", async () => {
    const { client, store: r2Store } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = { db, r2Client: client, r2Config, pathKey, authId };

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

    const pageRows = [...db.store.pages.values()];
    expect(pageRows).toHaveLength(2);
    expect(pageRows.every((r) => r.owner === authId)).toBe(true);
    // path must be the real encrypted pointer, not a placeholder, and must
    // never be brotli-compressed first (a plain AEAD blob's minimum length
    // is 132 bytes -- see docs/crypto.md).
    expect(
      pageRows.every((r) => Buffer.from(r.path, "base64").length >= 132),
    ).toBe(true);

    const page2 = await fetchPage(cfg, 2, 1);
    expect(Array.from(page2)).toEqual(Array.from(new Uint8Array(64).fill(2)));
  });

  it("retries the commit if a concurrent writer already advanced currentVersion", async () => {
    const { client } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = { db, r2Client: client, r2Config, pathKey, authId };

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
    const cfg = { db, r2Client: client, r2Config, pathKey, authId };

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

  it("never brotli-compresses the pointer content before encrypting it, and never bakes r2Prefix into it", async () => {
    const { client, store: r2Store } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = { db, r2Client: client, r2Config, pathKey, authId };

    await commitPages(
      cfg,
      new Map([[1, new Uint8Array(64).fill(1)]]),
      dbMetaId,
      0,
      1,
      64,
    );

    const [pageRow] = [...db.store.pages.values()];
    const rawKey = new TextDecoder().decode(
      await blob.decrypt(pathKey, Buffer.from(pageRow.path, "base64"), false),
    );
    // The encrypted content is just the random key -- r2Prefix (a pure,
    // deterministic function of authId) is never baked into it, since it's
    // cheaply re-derivable at read/write time instead of stored redundantly.
    expect(rawKey).not.toContain("/");
    expect(rawKey).toMatch(CROCKFORD_BASE32_RE);
    expect(r2Store.has(`${r2Prefix}/${rawKey}`)).toBe(true);
  });
});

describe("fetchPagesBatch", () => {
  it("resolves many page numbers via a single query instead of one per page", async () => {
    const { client } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = { db, r2Client: client, r2Config, pathKey, authId };

    await commitPages(
      cfg,
      new Map([
        [1, new Uint8Array(64).fill(1)],
        [2, new Uint8Array(64).fill(2)],
        [3, new Uint8Array(64).fill(3)],
      ]),
      dbMetaId,
      0,
      3,
      64,
    );

    const queryOnceSpy = vi.spyOn(db, "queryOnce");
    const pages = await fetchPagesBatch(cfg, [1, 2, 3], 1);

    expect(pages.size).toBe(3);
    expect(Array.from(pages.get(2)!)).toEqual(
      Array.from(new Uint8Array(64).fill(2)),
    );
    // The whole point: one InstantDB query for all 3 pages, not 3 separate
    // ones (dbWorker.ts's prefetchPages used to do the latter).
    expect(queryOnceSpy).toHaveBeenCalledOnce();
  });

  it("picks the highest version <= targetVersion per page, not just the latest commit overall", async () => {
    const { client } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = { db, r2Client: client, r2Config, pathKey, authId };

    // version=1: pages 1 and 2.
    await commitPages(
      cfg,
      new Map([
        [1, new Uint8Array(64).fill(10)],
        [2, new Uint8Array(64).fill(20)],
      ]),
      dbMetaId,
      0,
      2,
      64,
    );
    // version=2: page 1 only, re-written with different content.
    await commitPages(
      cfg,
      new Map([[1, new Uint8Array(64).fill(11)]]),
      dbMetaId,
      1,
      2,
      64,
    );

    // Asking as of version=1 must still return page 1's *version-1* bytes,
    // even though a newer version=2 row for page 1 now also exists.
    const asOfV1 = await fetchPagesBatch(cfg, [1, 2], 1);
    expect(Array.from(asOfV1.get(1)!)).toEqual(
      Array.from(new Uint8Array(64).fill(10)),
    );
    expect(Array.from(asOfV1.get(2)!)).toEqual(
      Array.from(new Uint8Array(64).fill(20)),
    );

    const asOfV2 = await fetchPagesBatch(cfg, [1, 2], 2);
    expect(Array.from(asOfV2.get(1)!)).toEqual(
      Array.from(new Uint8Array(64).fill(11)),
    );
  });

  it("paginates across many pages rows instead of one unbounded query", async () => {
    const { client } = fakeR2();
    const db = fakeInstantDb();
    db.store.dbMeta.set(dbMetaId, { id: dbMetaId, currentVersion: 0 });
    const cfg = { db, r2Client: client, r2Config, pathKey, authId };

    const pageCount = 1200; // forces 3 rounds at PAGES_QUERY_PAGE_SIZE=500
    const dirty = new Map(
      Array.from({ length: pageCount }, (_, i) => [
        i + 1,
        new Uint8Array(8).fill(i % 256),
      ]),
    );
    await commitPages(cfg, dirty, dbMetaId, 0, pageCount, 8);

    const queryOnceSpy = vi.spyOn(db, "queryOnce");
    const pageNos = Array.from({ length: pageCount }, (_, i) => i + 1);
    const pages = await fetchPagesBatch(cfg, pageNos, 1);

    expect(pages.size).toBe(pageCount);
    // pageNo 777 was written from array index 776 (pageNo = i + 1).
    expect(Array.from(pages.get(777)!)).toEqual(
      Array.from(new Uint8Array(8).fill(776 % 256)),
    );
    expect(queryOnceSpy).toHaveBeenCalledTimes(3);
  });

  it("returns an empty map for an empty page-number list without querying at all", async () => {
    const { client } = fakeR2();
    const db = fakeInstantDb();
    const cfg = { db, r2Client: client, r2Config, pathKey, authId };
    const queryOnceSpy = vi.spyOn(db, "queryOnce");

    const pages = await fetchPagesBatch(cfg, [], 1);

    expect(pages.size).toBe(0);
    expect(queryOnceSpy).not.toHaveBeenCalled();
  });
});
