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
import * as blob from "../crypto/blob";
import { computeR2Prefix, generateRawKey } from "./pagePointer";
import { getObject, putObject } from "./r2";
import type { R2Config } from "./r2Config";

// Same value as the CLI's R2_BATCH_CONCURRENCY (txt/constants.ts) -- bounded
// parallelism for per-page R2/InstantDB round-trips, not one at a time
// (slow) or fully unbounded (risks exhausting connections/R2 rate limits).
const UPLOAD_BATCH_CONCURRENCY = 8;
const CAS_MAX_RETRIES = 3;

export interface InstantPageStoreConfig {
  db: any; // @instantdb/react database instance
  r2Client: AwsClient;
  r2Config: R2Config;
  pathKey: Uint8Array;
  authId: string; // $users id -- pageKey identity and (via computeR2Prefix) R2 prefix
  ownerId: string; // `users` profile row id -- pages/dbMeta/$files owner link target
}

export interface CommitResult {
  newVersion: number;
  pageCount: number;
}

interface UploadedPage {
  fileId: string;
  pageKey: string;
}

// content only ever wraps rawKey (the random suffix) -- rawPath (the full
// R2 object address, prefix included) is what the actual PUT needs, but the
// prefix itself is never part of what gets encrypted, since it's already
// derivable from authId at read time.
interface PreparedUpload {
  pageNo: number;
  pageKey: string;
  rawPath: string;
  body: Uint8Array;
  content: Uint8Array;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export async function fetchPage(
  cfg: InstantPageStoreConfig,
  pageNo: number,
  targetVersion: number,
): Promise<Uint8Array> {
  const url = await resolvePagePointerUrl(cfg, pageNo, targetVersion);
  const content = await downloadPointerContent(url);
  const rawKey = utf8Decoder.decode(await blob.decrypt(cfg.pathKey, content));
  const rawPath = `${computeR2Prefix(cfg.authId)}/${rawKey}`;
  return getObject(cfg.r2Client, cfg.r2Config, rawPath);
}

async function resolvePagePointerUrl(
  cfg: InstantPageStoreConfig,
  pageNo: number,
  targetVersion: number,
): Promise<string> {
  const result = await cfg.db.queryOnce({
    pages: {
      $: {
        where: {
          "owner.id": cfg.ownerId,
          pageNo,
          version: { $lte: targetVersion },
        },
        order: { version: "desc" },
        limit: 1,
      },
      pointerFile: {},
    },
  });
  const row = result.data.pages?.[0];
  if (!row) {
    throw new Error(
      `no page row for pageNo=${pageNo} version<=${targetVersion}`,
    );
  }
  return row.pointerFile[0].url;
}

async function downloadPointerContent(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `failed to download $files pointer content: HTTP ${resp.status}`,
    );
  }
  return new Uint8Array(await resp.arrayBuffer());
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
  // Never brotli-compress rawKey before encrypting it -- it's a short
  // random string, not a structured/JSON payload (crypto/blob.ts's
  // `compressed` option is left at its default false, same as the CLI's
  // pagePointer.ts).
  const content = await blob.encrypt(cfg.pathKey, utf8.encode(rawKey));
  return { pageNo, pageKey, rawPath, body, content };
}

// R2 PUT before the $files upload, matching the commit protocol
// (docs/data_model.md): if this throws between the two, the result is an
// untracked R2 object (the GC design's "untracked R2 objects" sweep already
// accounts for this), never a $files pointer referencing an R2 object that
// was never written.
async function uploadOne(
  cfg: InstantPageStoreConfig,
  p: PreparedUpload,
): Promise<UploadedPage> {
  await putObject(cfg.r2Client, cfg.r2Config, p.rawPath, p.body);
  const { data } = await cfg.db.storage.uploadFile(
    p.pageKey,
    new Blob([p.content as BlobPart]),
  );
  return { fileId: data.id, pageKey: p.pageKey };
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
  const fileOwnerTxs = [...uploaded.values()].map((info) =>
    tx.$files[info.fileId].link({ owner: cfg.ownerId }),
  );
  const dbMetaTx = tx.dbMeta[dbMetaId]
    .update({ currentVersion: newVersion, pageCount, pageSize, needsGc: false })
    .link({ owner: cfg.ownerId });
  await cfg.db.transact([...pageTxs, ...fileOwnerTxs, dbMetaTx]);
}

function pageTx(
  cfg: InstantPageStoreConfig,
  pageNo: number,
  info: UploadedPage,
  version: number,
) {
  return tx.pages[id()]
    .update({ pageKey: info.pageKey, pageNo, version })
    .link({ owner: cfg.ownerId, pointerFile: info.fileId });
}
