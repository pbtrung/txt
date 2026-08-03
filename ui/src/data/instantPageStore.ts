// Browser mirror of txt/remotePageStore.ts: the read (fetchPage) and write
// (commitPages) primitives for the page store, talking to InstantDB via the
// real client SDK (permission-rule-gated -- db.queryOnce/db.transact/
// db.storage.uploadFile, not an admin token a browser can never safely
// hold) and R2 via aws4fetch (r2.ts). Unlike the CLI's version, commitPages
// here actually has to survive a concurrent writer: docs/data_model.md's
// CAS check (dbMeta's update rule, newData.currentVersion ==
// data.currentVersion + 1) is enforced by InstantDB's own permission rules
// for a client-SDK write, so a losing writer's transact() is rejected
// outright -- retryCommit below is what recovers from that, by re-reading
// the real current version and retrying, up to a bounded number of times.
import { id, tx } from "@instantdb/react";
import type { AwsClient } from "aws4fetch";
import { collectAllPages } from "./instaqlPagination";
import {
  computeR2Prefix,
  decodePagePointerContent,
  encodePagePointerContent,
  generateRawKey,
} from "./pagePointer";
import { getObject, putObject } from "./r2";
import type { R2Config } from "./r2Config";

// Same value as the CLI's R2_BATCH_CONCURRENCY (txt/constants.ts) -- bounded
// parallelism for per-page R2/InstantDB round-trips, not one at a time
// (slow) or fully unbounded (risks exhausting connections/R2 rate limits).
const UPLOAD_BATCH_CONCURRENCY = 8;
// Same reasoning, for fetchPagesBatch's own R2 GETs -- matches
// dbWorker.ts's own (recently tuned) prefetch concurrency, which used to
// live there as its own loop before that loop moved into fetchPagesBatch.
const FETCH_BATCH_CONCURRENCY = 15;
// Bounded page size for fetchPagesBatch's own InstantDB query -- even one
// prefetch batch of many page numbers could return more rows than this if
// some of them have several historical versions, so it still needs its own
// pagination loop (collectAllPages), not just one unbounded query.
const PAGES_QUERY_PAGE_SIZE = 500;
const CAS_MAX_RETRIES = 3;

export interface InstantPageStoreConfig {
  db: any; // @instantdb/react database instance
  r2Client: AwsClient;
  r2Config: R2Config;
  pathKey: Uint8Array;
  // $users id -- pageKey identity, R2 prefix (via computeR2Prefix), and the
  // pages/dbMeta/activeReaders owner link target (owner links to $users
  // directly now, no separate `users` profile row to resolve first).
  authId: string;
}

export interface CommitResult {
  newVersion: number;
  pageCount: number;
}

interface UploadedPage {
  pageKey: string;
  path: string; // base64 -- goes directly onto the pages row, no $files upload
}

// path only ever wraps rawKey (the random suffix) -- rawPath (the full R2
// object address, prefix included) is what the actual PUT needs, but the
// prefix itself is never part of what gets encrypted, since it's already
// derivable from authId at read time.
interface PreparedUpload {
  pageNo: number;
  pageKey: string;
  rawPath: string;
  body: Uint8Array;
  path: string;
}

export async function fetchPage(
  cfg: InstantPageStoreConfig,
  pageNo: number,
  targetVersion: number,
): Promise<Uint8Array> {
  const path = await resolvePagePath(cfg, pageNo, targetVersion);
  return resolvePageBytes(cfg, path);
}

/** Batched counterpart to fetchPage -- resolves many page numbers via a
 * bounded number of InstantDB queries (pageNo: {$in: pageNos}, paginated)
 * instead of one query per page number, which is what dbWorker.ts's
 * open()-time prefetch used to do (up to MAX_CACHED_PAGES individual
 * queries, concurrency-limited but not count-reduced -- fine for a few
 * hundred pages, not for an account with tens of thousands). Only usable
 * for a known, up-front page list -- the lazy on-demand path
 * (remotePageWorker.ts's own use of fetchPage, one page at a time as
 * SQLite's own xRead needs it) can't be batched this way, since it doesn't
 * know its next page number until SQLite asks for it. */
export async function fetchPagesBatch(
  cfg: InstantPageStoreConfig,
  pageNos: number[],
  targetVersion: number,
): Promise<Map<number, Uint8Array>> {
  if (pageNos.length === 0) return new Map();
  const rows = await collectAllPages<{
    pageNo: number;
    version: number;
    path: string;
  }>(async (after) => {
    const result = await cfg.db.queryOnce({
      pages: {
        $: {
          where: {
            "owner.id": cfg.authId,
            pageNo: { $in: pageNos },
            version: { $lte: targetVersion },
          },
          order: { pageKey: "asc" },
          limit: PAGES_QUERY_PAGE_SIZE,
          ...(after ? { after } : {}),
        },
      },
    });
    const pageInfo = result.pageInfo?.pages;
    return {
      rows: result.data.pages ?? [],
      hasNextPage: !!pageInfo?.hasNextPage,
      endCursor: pageInfo?.endCursor,
    };
  });

  // Multiple historical versions of the same page can come back -- keep
  // only the highest version <= targetVersion for each requested pageNo
  // (the same "latest version at or before this snapshot" rule
  // resolvePagePath's own order-by-version-desc/limit-1 enforces per page; a
  // single batched query can't apply a per-group limit, so this is resolved
  // client-side instead).
  const bestPathByPageNo = new Map<number, string>();
  const bestVersionByPageNo = new Map<number, number>();
  for (const row of rows) {
    const bestVersion = bestVersionByPageNo.get(row.pageNo);
    if (bestVersion === undefined || row.version > bestVersion) {
      bestVersionByPageNo.set(row.pageNo, row.version);
      bestPathByPageNo.set(row.pageNo, row.path);
    }
  }

  const result = new Map<number, Uint8Array>();
  const entries = [...bestPathByPageNo.entries()];
  for (let i = 0; i < entries.length; i += FETCH_BATCH_CONCURRENCY) {
    const batch = entries.slice(i, i + FETCH_BATCH_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(
        async ([pageNo, path]) =>
          [pageNo, await resolvePageBytes(cfg, path)] as const,
      ),
    );
    resolved.forEach(([pageNo, bytes]) => result.set(pageNo, bytes));
  }
  return result;
}

// Shared by fetchPage/fetchPagesBatch: path is the pages row's own field
// (base64, decrypt-in-place to recover raw_key -- no linked file, no
// download), then GET the real page bytes from R2.
async function resolvePageBytes(
  cfg: InstantPageStoreConfig,
  path: string,
): Promise<Uint8Array> {
  const rawKey = await decodePagePointerContent(cfg.pathKey, path);
  const rawPath = `${computeR2Prefix(cfg.authId)}/${rawKey}`;
  return getObject(cfg.r2Client, cfg.r2Config, rawPath);
}

async function resolvePagePath(
  cfg: InstantPageStoreConfig,
  pageNo: number,
  targetVersion: number,
): Promise<string> {
  const result = await cfg.db.queryOnce({
    pages: {
      $: {
        where: {
          "owner.id": cfg.authId,
          pageNo,
          version: { $lte: targetVersion },
        },
        order: { version: "desc" },
        limit: 1,
      },
    },
  });
  const row = result.data.pages?.[0];
  if (!row) {
    throw new Error(
      `no page row for pageNo=${pageNo} version<=${targetVersion}`,
    );
  }
  return row.path;
}

/** Uploads every dirty page as a new version and CAS-bumps dbMeta, retrying
 * (re-reading the real current version and redoing the whole upload+
 * transact under a fresh version number) if a concurrent writer's commit
 * won the race first -- up to CAS_MAX_RETRIES times before giving up. */
export async function commitPages(
  cfg: InstantPageStoreConfig,
  dirtyPages: Map<number, Uint8Array>,
  dbMetaId: string,
  currentVersion: number,
  pageCount: number,
  pageSize: number,
): Promise<CommitResult> {
  let version = currentVersion;
  for (let attempt = 0; ; attempt++) {
    const newVersion = version + 1;
    const uploaded = await uploadPages(cfg, dirtyPages, newVersion);
    try {
      await transactPages(
        cfg,
        uploaded,
        newVersion,
        dbMetaId,
        pageCount,
        pageSize,
      );
      return { newVersion, pageCount };
    } catch (err) {
      if (attempt >= CAS_MAX_RETRIES) throw err;
      version = await fetchCurrentVersion(cfg, dbMetaId);
    }
  }
}

async function fetchCurrentVersion(
  cfg: InstantPageStoreConfig,
  dbMetaId: string,
): Promise<number> {
  const result = await cfg.db.queryOnce({
    dbMeta: { $: { where: { id: dbMetaId } } },
  });
  const row = result.data.dbMeta?.[0];
  if (!row)
    throw new Error(`dbMeta row ${dbMetaId} not found while retrying commit`);
  return row.currentVersion;
}

async function uploadPages(
  cfg: InstantPageStoreConfig,
  dirtyPages: Map<number, Uint8Array>,
  version: number,
): Promise<Map<number, UploadedPage>> {
  const prepared = await Promise.all(
    [...dirtyPages].map(([pageNo, body]) =>
      prepareUpload(cfg, pageNo, body, version),
    ),
  );
  const uploaded = new Map<number, UploadedPage>();
  for (let i = 0; i < prepared.length; i += UPLOAD_BATCH_CONCURRENCY) {
    const batch = prepared.slice(i, i + UPLOAD_BATCH_CONCURRENCY);
    const results = await Promise.all(batch.map((p) => uploadOne(cfg, p)));
    batch.forEach((p, idx) => uploaded.set(p.pageNo, results[idx]));
  }
  return uploaded;
}

async function prepareUpload(
  cfg: InstantPageStoreConfig,
  pageNo: number,
  body: Uint8Array,
  version: number,
): Promise<PreparedUpload> {
  const pageKey = `${cfg.authId}:${pageNo}:${version}`;
  const rawKey = generateRawKey();
  const rawPath = `${computeR2Prefix(cfg.authId)}/${rawKey}`;
  const path = await encodePagePointerContent(cfg.pathKey, rawKey);
  return { pageNo, pageKey, rawPath, body, path };
}

// R2 PUT, matching the commit protocol (docs/data_model.md): if this throws
// before the pages row is ever created, the result is an untracked R2
// object (the GC design's "untracked R2 objects" sweep already accounts for
// this), never a pages row whose path resolves to something never written.
async function uploadOne(
  cfg: InstantPageStoreConfig,
  p: PreparedUpload,
): Promise<UploadedPage> {
  await putObject(cfg.r2Client, cfg.r2Config, p.rawPath, p.body);
  return { pageKey: p.pageKey, path: p.path };
}

async function transactPages(
  cfg: InstantPageStoreConfig,
  uploaded: Map<number, UploadedPage>,
  newVersion: number,
  dbMetaId: string,
  pageCount: number,
  pageSize: number,
): Promise<void> {
  const pageTxs = [...uploaded].map(([pageNo, info]) =>
    pageTx(cfg, pageNo, info, newVersion),
  );
  const dbMetaTx = tx.dbMeta[dbMetaId]
    .update({ currentVersion: newVersion, pageCount, pageSize, needsGc: false })
    .link({ owner: cfg.authId });
  await cfg.db.transact([...pageTxs, dbMetaTx]);
}

function pageTx(
  cfg: InstantPageStoreConfig,
  pageNo: number,
  info: UploadedPage,
  version: number,
) {
  return tx.pages[id()]
    .update({ pageKey: info.pageKey, pageNo, version, path: info.path })
    .link({ owner: cfg.authId });
}
