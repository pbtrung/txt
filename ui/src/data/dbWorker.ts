// Runs as a real Worker -- this is where SqliteDb/registerRemoteVfs actually
// live now, not the main thread. A real browser forbids Atomics.wait()
// outside a Worker (confirmed against genuine Chromium: it throws
// "Atomics.wait cannot be called in this context" when called from the
// main/document thread), but remoteVfs.ts's xRead needs exactly that to
// bridge SQLite's synchronous WASM callback to remotePageClient.ts's async
// fetch -- so the whole SQLite/VFS/commit layer has to live in a Worker,
// with the main thread (state/VaultContext.tsx, screens/Reader/
// useReaderBook.ts) talking to it via the small RPC protocol below instead
// of holding a SqliteDb directly. remotePageWorker.ts (the actual page-fetch
// worker) is then a *nested* Worker spawned from here, same
// startRemotePageWorker() call remotePageClient.ts already provides --
// nesting workers is a normal, supported browser capability, so nothing
// there needed to change.
//
// This worker needs its own InstantDB session, same reasoning as
// remotePageWorker.ts's header comment: a Worker can't share a live client
// object with the main thread, only structured-cloneable data, so open()
// re-signs-in from the same Firebase idToken VaultContext already used to
// resolve the session (session.ts's resolveSession, on the main thread --
// that part doesn't need repeating here, its *result* is what open() takes).
//
// Every write (recordReadPosition/removeAccessEntry/addBookmarkEntry/
// removeBookmarkEntry) is serialized through requestQueue below: each
// handler's own `await commitOrThrow(...)` yields back to this worker's
// event loop, so two RPC calls in flight at once could otherwise interleave
// against the shared vfs dirty-page/commit state the same way two
// unserialized main-thread calls used to (see the state this replaced in
// VaultContext.tsx's git history) -- queuing every call through one promise
// chain keeps each write+commit atomic relative to the next.

import { tx } from "@instantdb/react";
import { verbose } from "../log";
import * as access from "./access";
import * as bookmarks from "./bookmarks";
import { createInstantClient } from "./instantClient";
import * as instantPageStore from "./instantPageStore";
import type { InstantPageStoreConfig } from "./instantPageStore";
import { loadLibrary } from "./library";
import * as owner from "./owner";
import type { R2Config } from "./r2Config";
import { fetchTempR2Credential } from "./tempR2Creds";
import {
  registerRemoteVfs,
  MAX_CACHED_PAGES,
  type RemoteVfsHandle,
  type RemoteVfsStats,
} from "./remoteVfs";
import {
  startRemotePageWorker,
  type RemotePageBridge,
} from "./remotePageClient";
import { SqliteDb } from "./sqliteDb";
import { loadWasm } from "./wasmLoader";

export interface OpenParams {
  instantAppId: string;
  instantClientName: string;
  idToken: string;
  authId: string;
  ownerId: string; // `users` profile row id -- pages/dbMeta/$files/activeReaders owner link target
  dbMetaId: string;
  currentVersion: number;
  pageCount: number;
  pageSize: number;
  r2Config: R2Config;
  pathKey: Uint8Array;
  dbKey: Uint8Array;
}

let db: SqliteDb | null = null;
let vfs: RemoteVfsHandle | null = null;
let instantDb: any = null; // @instantdb/react database instance, this worker's own session
let pageStoreCfg: InstantPageStoreConfig | null = null;
let dbMetaId: string | null = null;
let pageWorker: RemotePageBridge | null = null;
let storedOpenParams: OpenParams | null = null;
let readerId: string | null = null;
let renewReaderTimer: ReturnType<typeof setInterval> | null = null;
let r2CredRefreshTimer: ReturnType<typeof setInterval> | null = null;

// How long a registered reader lease (docs/data_model.md's activeReaders)
// stays valid without renewal, and how often it's renewed while a session
// is open. Without this lease, GC's watermark computation sees no active
// readers at all for this account and falls back to currentVersion --
// meaning it can delete every page version below the *latest* one, breaking
// a long-lived session still pinned to an older snapshot ("page N not found
// at or before snapshot M"). Renewed at half the lease duration so one
// missed renewal (a network hiccup) doesn't let the lease lapse.
const READER_LEASE_MS = 5 * 60 * 1000;
const READER_RENEW_INTERVAL_MS = READER_LEASE_MS / 2;

// worker/r2Creds.ts's own TTL_SECONDS is 900s (15 minutes) -- refreshed at
// a comfortable margin before that so a slow refresh request never risks
// the old credential expiring mid-flight.
const R2_CRED_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

// Bounded concurrency for the initial page prefetch (same value as
// txt/constants.ts's R2_BATCH_CONCURRENCY / instantPageStore.ts's own
// upload-side batching) -- each page here is a query + a pointer download +
// an R2 GET, so one at a time would be slow for anything beyond a handful
// of pages, and fully unbounded risks exhausting connections.
const PREFETCH_CONCURRENCY = 8;

// Independent of MAX_CACHED_PAGES in principle, but currently set equal to
// it: prefetch the whole cache budget upfront (right after open() learns
// the page count) rather than leaving it all to be discovered and fetched
// individually later by SQLite's own page-at-a-time xRead callback -- that's
// what made the initial "Loading your books..." unlock phase slow
// (loadLibrary()/loadBookmarksMap() touch a lot of small, scattered pages
// on a first open, each one its own round trip through remotePageClient.ts's
// Atomics bridge).
const PREFETCH_PAGE_LIMIT = MAX_CACHED_PAGES;

/** Registers or renews (an InstantDB update() on this reader's own id is an
 * upsert -- creates the row the first time, updates it thereafter) this
 * session's own activeReaders row, pinned to snapshotVersion. Errors are
 * swallowed -- a missed renewal just means the lease lapses a bit early
 * next GC sweep, not a session-ending failure; the next successful renewal
 * (or the next commit) re-establishes it. */
async function beginRead(
  readerIdValue: string,
  snapshotVersion: number,
): Promise<void> {
  if (!instantDb || !storedOpenParams) return;
  try {
    await instantDb.transact([
      tx.activeReaders[readerIdValue]
        .update({
          snapshotVersion,
          leaseExpiresAt: Date.now() + READER_LEASE_MS,
        })
        .link({ owner: storedOpenParams.ownerId }),
    ]);
  } catch (err) {
    verbose(
      "dbWorker: activeReaders lease renewal failed (will retry on next renewal/commit)",
      err,
    );
  }
}

function requireOpen(): {
  db: SqliteDb;
  vfs: RemoteVfsHandle;
  pageStoreCfg: InstantPageStoreConfig;
  dbMetaId: string;
} {
  if (!db || !vfs || !pageStoreCfg || !dbMetaId)
    throw new Error("vault is locked");
  return { db, vfs, pageStoreCfg, dbMetaId };
}

/** Eagerly fetches this account's pages in bounded-concurrency batches
 * right after open() learns the page count, instead of leaving every one
 * of them to be discovered and fetched individually later. Capped at
 * PREFETCH_PAGE_LIMIT, not fetching more than that up front just isn't
 * worth the added latency for pages a given session may never touch.
 * Returns pages keyed by page number, fed into vfs.primeCache() by the
 * caller. */
async function prefetchPages(
  cfg: InstantPageStoreConfig,
  pageCount: number,
  snapshot: number,
): Promise<Map<number, Uint8Array>> {
  const total = Math.min(pageCount, PREFETCH_PAGE_LIMIT);
  const pageNos = Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Map<number, Uint8Array>();
  const start = performance.now();
  for (let i = 0; i < pageNos.length; i += PREFETCH_CONCURRENCY) {
    const batch = pageNos.slice(i, i + PREFETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map((pageNo) => instantPageStore.fetchPage(cfg, pageNo, snapshot)),
    );
    batch.forEach((pageNo, idx) => pages.set(pageNo, results[idx]));
  }
  verbose(
    `dbWorker: prefetch done -- ${pages.size} page(s), ${(performance.now() - start).toFixed(1)}ms`,
  );
  return pages;
}

/** Opens (or re-opens, for refresh) this account's SQLCipher db against a
 * fresh lazy VFS -- always a brand new nested worker/VFS registration/
 * backed-path, never reused, since sqlite3_vfs_register has no "replace"
 * semantics. */
export async function open(params: OpenParams): Promise<void> {
  await close();
  storedOpenParams = params;

  verbose("dbWorker: open() -- creating this worker's own InstantDB client");
  instantDb = createInstantClient(params.instantAppId);
  verbose("dbWorker: open() -- signing in (db.auth.signInWithIdToken)");
  await instantDb.auth.signInWithIdToken({
    clientName: params.instantClientName,
    idToken: params.idToken,
  });
  verbose("dbWorker: open() -- signed in");

  verbose("dbWorker: open() -- minting a temporary R2 credential");
  const r2Cred = await fetchTempR2Credential(
    params.idToken,
    params.authId,
    params.r2Config,
  );
  verbose("dbWorker: open() -- temporary R2 credential minted");
  pageStoreCfg = {
    db: instantDb,
    r2Client: r2Cred.client,
    r2Config: params.r2Config,
    pathKey: params.pathKey,
    authId: params.authId,
    ownerId: params.ownerId,
  };
  dbMetaId = params.dbMetaId;
  r2CredRefreshTimer = setInterval(
    () => void refreshR2Credential(),
    R2_CRED_REFRESH_INTERVAL_MS,
  );

  // Registered immediately, before any of the (potentially slow, for a
  // large vault) prefetch/SqliteDb.open work below -- every moment between
  // pinning currentVersion and having a lease actually recorded for it is a
  // window GC could still delete a page this snapshot needs.
  readerId = crypto.randomUUID();
  verbose(`dbWorker: open() -- registering activeReaders lease ${readerId}`);
  await beginRead(readerId, params.currentVersion);
  verbose("dbWorker: open() -- lease registered");
  renewReaderTimer = setInterval(
    () => void renewReader(),
    READER_RENEW_INTERVAL_MS,
  );

  verbose("dbWorker: open() -- spawning nested remotePageWorker");
  pageWorker = await startRemotePageWorker(
    {
      instantAppId: params.instantAppId,
      instantClientName: params.instantClientName,
      idToken: params.idToken,
      r2Config: params.r2Config,
      pathKey: params.pathKey,
      authId: params.authId,
      ownerId: params.ownerId,
    },
    params.pageSize,
    params.currentVersion,
  );
  verbose("dbWorker: open() -- remotePageWorker ready");
  const sessionId = crypto.randomUUID();
  const backedPath = `/vault-${sessionId}.db`;
  verbose("dbWorker: open() -- loading sqlcipher.wasm");
  const mod = await loadWasm();
  verbose("dbWorker: open() -- sqlcipher.wasm loaded, registering VFS");
  vfs = registerRemoteVfs(mod, {
    name: `remotevfs-${sessionId}`,
    pageSize: params.pageSize,
    pageCount: params.pageCount,
    currentVersion: params.currentVersion,
    backedPath,
    fetchPage: pageWorker.fetchPage,
  });
  verbose(`dbWorker: open() -- prefetching up to ${params.pageCount} page(s)`);
  const prefetched = await prefetchPages(
    pageStoreCfg,
    params.pageCount,
    params.currentVersion,
  );
  vfs.primeCache(prefetched);
  verbose("dbWorker: open() -- keying and opening the SQLCipher db");
  db = await SqliteDb.open(backedPath, {
    vfsName: vfs.name,
    rawKey: params.dbKey,
    pageSize: params.pageSize,
  });
  verbose("dbWorker: open() -- done");
}

/** Renews this session's own reader lease at its own latest known snapshot
 * -- called periodically (renewReaderTimer) and right after every commit,
 * so both the lease's expiry and its pinned snapshot_version stay current
 * without waiting for the next periodic tick. */
async function renewReader(): Promise<void> {
  if (!vfs || !readerId) return;
  await beginRead(readerId, vfs.getCurrentVersion());
}

/** Re-mints this session's own R2 credential before its 15-minute TTL
 * (worker/r2Creds.ts's TTL_SECONDS) runs out -- called periodically
 * (r2CredRefreshTimer). Swaps pageStoreCfg.r2Client in place; every caller
 * (instantPageStore.ts's fetchPage/commitPages) reads it fresh off that
 * shared config object rather than holding its own reference. */
async function refreshR2Credential(): Promise<void> {
  if (!pageStoreCfg || !storedOpenParams) return;
  const r2Cred = await fetchTempR2Credential(
    storedOpenParams.idToken,
    storedOpenParams.authId,
    storedOpenParams.r2Config,
  );
  pageStoreCfg.r2Client = r2Cred.client;
  verbose("dbWorker: refreshed temporary R2 credential");
}

export async function refresh(): Promise<void> {
  if (!storedOpenParams) throw new Error("vault is locked");
  await open(storedOpenParams);
}

export async function close(): Promise<void> {
  if (renewReaderTimer) clearInterval(renewReaderTimer);
  renewReaderTimer = null;
  if (r2CredRefreshTimer) clearInterval(r2CredRefreshTimer);
  r2CredRefreshTimer = null;
  if (instantDb && readerId) {
    try {
      await instantDb.transact([tx.activeReaders[readerId].delete()]);
    } catch (err) {
      verbose(
        "dbWorker: activeReaders lease delete failed (lease will just expire on its own)",
        err,
      );
    }
  }
  readerId = null;
  pageWorker?.terminate();
  db?.close();
  db = null;
  vfs = null;
  instantDb = null;
  pageStoreCfg = null;
  dbMetaId = null;
  pageWorker = null;
}

/** Flushes dirty pages via one commit -- instantPageStore.ts's commitPages
 * already retries internally on a lost CAS race (see its own doc comment),
 * so a rejection here means those retries were exhausted, not "try again
 * yourself" (unlike the old rqlite-backed version's commit contract).
 * Advances both pageWorker's pinned snapshot (RemotePageBridge.
 * updateSnapshot) and this session's own activeReaders lease (renewReader)
 * to the just-committed version afterward -- without that, a later live
 * fetch (a cache miss, or a page evicted from the LRU cache since) for a
 * page only written by this or an earlier commit this session would come
 * back "not found" against the stale snapshot/lease pinned at open() time. */
export async function commitOrThrow(): Promise<void> {
  const { vfs, pageStoreCfg, dbMetaId } = requireOpen();
  await vfs.commit((dirtyPages, currentVersion, pageCount, pageSize) =>
    instantPageStore.commitPages(
      pageStoreCfg,
      dirtyPages,
      dbMetaId,
      currentVersion,
      pageCount,
      pageSize,
    ),
  );
  pageWorker?.updateSnapshot(vfs.getCurrentVersion());
  await renewReader();
}

/** This session's remoteVfs.ts page-fetch stats (roundtrip count/timing,
 * bytes fetched) -- mirrors txt/remoteVfs.ts's identical RemoteVfsStats,
 * which txt.ts --test-perf reports on the CLI side; this is ui/'s own
 * consumer of the same instrumentation (VaultContext.tsx logs a summary
 * after unlock's loadLibrary/loadBookmarksMap). Only counts pages fetched
 * individually via getPage() -- prefetchPages' batched reads bypass it
 * entirely via vfs.primeCache(), so this reflects cache misses past the
 * prefetch, not total pages read. */
export function fetchVfsStats(): RemoteVfsStats {
  const { vfs } = requireOpen();
  return vfs.stats;
}

export async function loadLibraryHandler() {
  const { db } = requireOpen();
  const result = await loadLibrary(db);
  verbose(
    `dbWorker: loadLibrary -- ${result.metadataById.size} book(s), ` +
      `${result.accessMap.size} with access position`,
  );
  return result;
}

export function loadBookmarksMapHandler() {
  const { db } = requireOpen();
  const map = bookmarks.loadBookmarksMap(db);
  verbose(`dbWorker: loadBookmarksMap -- ${map.size} txt_id(s) with bookmarks`);
  return map;
}

export async function recordReadPosition(
  txtId: number,
  position: access.ReadPosition,
): Promise<void> {
  const { db } = requireOpen();
  verbose(
    `dbWorker: recordReadPosition txtId=${txtId} ${JSON.stringify(position)}`,
  );
  access.setReadPosition(
    db,
    txtId,
    position.lastPartNum,
    position.lastAccessedMs,
  );
  await commitOrThrow();
}

export async function removeAccessEntry(txtId: number): Promise<void> {
  const { db } = requireOpen();
  access.clearReadPosition(db, txtId);
  await commitOrThrow();
}

export async function addBookmarkEntry(
  txtId: number,
  partNum: number,
  line: number,
  preview: string,
  createdAt: number,
) {
  const { db } = requireOpen();
  verbose(
    `dbWorker: addBookmarkEntry txtId=${txtId} partNum=${partNum} line=${line}`,
  );
  bookmarks.addBookmark(db, txtId, partNum, line, preview, createdAt);
  await commitOrThrow();
  const map = bookmarks.loadBookmarksMap(db);
  verbose(
    `dbWorker: addBookmarkEntry -- now ${map.get(txtId)?.length ?? 0} bookmark(s) for txtId=${txtId}`,
  );
  return map;
}

export async function removeBookmarkEntry(bookmarkId: number) {
  const { db } = requireOpen();
  bookmarks.removeBookmark(db, bookmarkId);
  await commitOrThrow();
  return bookmarks.loadBookmarksMap(db);
}

export function partCount(txtId: number): number {
  const { db } = requireOpen();
  return owner.partCount(db, txtId);
}

export function partContent(txtId: number, partNum: number): Uint8Array | null {
  const { db } = requireOpen();
  return owner.partContent(db, txtId, partNum);
}

const handlers: Record<string, (...args: any[]) => unknown> = {
  open,
  refresh,
  getVfsStats: fetchVfsStats,
  loadLibrary: loadLibraryHandler,
  loadBookmarksMap: loadBookmarksMapHandler,
  recordReadPosition,
  removeAccessEntry,
  addBookmarkEntry,
  removeBookmarkEntry,
  partCount,
  partContent,
};

interface RpcRequest {
  type: "call";
  id: number;
  method: string;
  args: unknown[];
}

// Serializes every RPC call through one promise chain -- see this file's
// header comment for why (write handlers' own internal awaits would
// otherwise let a second queued call start before the first's commit
// settles).
let queue: Promise<unknown> = Promise.resolve();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Guarded: this module is also imported directly by dbWorker.test.ts (to
// exercise open/recordReadPosition/etc. against a real SqliteDb without a
// real Worker environment, which Node/jsdom don't provide) -- `self` only
// exists in an actual Worker, so wiring this unconditionally would throw
// the moment a test imports the module at all.
if (typeof self !== "undefined") {
  self.onmessage = (ev: MessageEvent<RpcRequest>) => {
    const { id, method, args } = ev.data;
    const handler = handlers[method];
    const run = async () => {
      if (!handler) throw new Error(`dbWorker: unknown method ${method}`);
      return handler(...args);
    };
    queue = queue.then(run, run).then(
      (result) => self.postMessage({ type: "result", id, ok: true, result }),
      (err: unknown) =>
        self.postMessage({
          type: "result",
          id,
          ok: false,
          error: errorMessage(err),
        }),
    );
  };
}
