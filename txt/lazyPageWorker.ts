// Runs as a node:worker_threads Worker. Bridges lazyVfs.ts's synchronous
// xRead callback to a real async fetch: the main thread blocks in
// Atomics.wait() on a control SharedArrayBuffer while this worker does the
// actual InstantDB query + R2 GET and wakes it back up -- the same
// worker+Atomics bridge ui/src/data/remotePageWorker.ts/remotePageClient.ts
// already use for the browser (there because a real browser forbids
// Atomics.wait() on the main/document thread), ported to
// node:worker_threads (Node has no such restriction on its own main
// thread, but the fetch still has to happen on some *other* thread, or
// blocking the one thread that could ever process the fetch's completion
// would deadlock).
//
// Simpler than the browser version: this design's Admin SDK session
// (init({appId, adminToken})) is stateless and needs no per-thread
// re-authentication handshake the way a live client-SDK session does, and
// its R2 credentials are real, static keys rather than short-lived
// temp-minted ones -- so this worker just rebuilds its own RemotePageStore
// from plain, structured-cloneable config (workerData), no session
// handshake required, and no R2-credential-refresh timer either.
//
// Also simpler on the "which version to read" question: the browser's
// worker pins a snapshot version that has to advance (update-snapshot
// messages) as other live sessions keep committing concurrently.
// --migrate is single-writer and strictly sequential (never two commits in
// flight at once -- see migrate.ts's own comment on why), and pages this
// run hasn't itself dirtied yet don't change meaning as its *own* later
// commits happen, so the snapshot this worker fetches against is fixed for
// its whole lifetime, set once at construction.
import { parentPort, workerData } from "node:worker_threads";
import { init } from "@instantdb/admin";
import * as C from "./constants.ts";
import { CryptoEngine } from "./crypto.ts";
import { ConsoleLogger } from "./logger.ts";
import {
  CONTROL_LEN,
  CONTROL_STATUS,
  STATUS_ERROR,
  STATUS_OK,
  type LazyPageWorkerData,
} from "./lazyPageProtocol.ts";
import { R2Client } from "./r2.ts";
import { RemotePageStore } from "./remotePageStore.ts";

interface FetchMessage {
  type: "fetch";
  pageNo: number;
}

async function main(): Promise<void> {
  const data = workerData as LazyPageWorkerData;
  const log = new ConsoleLogger(data.verbose);
  const db = init({
    appId: data.instantAppId,
    adminToken: data.instantAdminToken,
  });
  const r2 = new R2Client(data.r2Config, false, log);
  const crypto = await CryptoEngine.create();
  const store = new RemotePageStore({
    db,
    r2,
    crypto,
    pathKey: Buffer.from(data.pathKey, "base64"),
    authId: data.authId,
  });
  const control = new Int32Array(data.controlSab);
  const dataBuf = new Uint8Array(data.dataSab);
  const snapshot = data.snapshot;
  let fetchCount = 0;

  function respond(status: number, bytes: Uint8Array): void {
    const n = Math.min(bytes.length, dataBuf.length);
    dataBuf.set(bytes.subarray(0, n), 0);
    Atomics.store(control, CONTROL_LEN, n);
    Atomics.store(control, CONTROL_STATUS, status);
    Atomics.notify(control, CONTROL_STATUS);
  }

  // General bounded LRU, not just a one-shot prefetch buffer: the initial
  // prefetch below warms it, but any later on-demand fetch also adds to it
  // (evicting the least-recently-touched entry past MIGRATE_PREFETCH_PAGE_
  // COUNT), so a page re-read after leaving the prefetch range -- or after
  // eviction -- can still hit this cache instead of paying another round
  // trip. lazyVfs.ts's own MAX_CACHED_PAGES=2000 cache on the main thread
  // already covers most repeat reads (getPage checks it before ever calling
  // opts.fetchPage into this worker at all); this one's main value is
  // low-numbered pages (schema page 1, early btree/index pages --
  // disproportionately likely to be hit early and often regardless of which
  // txt_id/txt_parts rows a given run needs) served from the very first
  // xRead, before they've ever been fetched individually. Never invalidated
  // -- correct only because --migrate is single-writer/strictly sequential
  // and this run's own commits always advance to freshly-allocated page
  // numbers past whatever pageCount was at construction (docs/data_model.md;
  // the same invariant this file's fixed snapshot already relies on).
  const cache = new Map<number, Buffer>();

  function cacheGet(pageNo: number): Buffer | undefined {
    const cached = cache.get(pageNo);
    if (cached !== undefined) {
      cache.delete(pageNo);
      cache.set(pageNo, cached);
    }
    return cached;
  }

  function cacheSet(pageNo: number, bytes: Buffer): void {
    cache.delete(pageNo);
    cache.set(pageNo, bytes);
    if (cache.size > C.MIGRATE_PREFETCH_PAGE_COUNT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  async function prefetchFirstPages(): Promise<void> {
    const n = Math.min(C.MIGRATE_PREFETCH_PAGE_COUNT, data.pageCount);
    if (n <= 0) return;
    const pageNos = Array.from({ length: n }, (_, i) => i + 1);
    const start = performance.now();
    const pages = await store.fetchPagesBatch(pageNos, snapshot);
    for (const [pageNo, bytes] of pages) cacheSet(pageNo, bytes);
    log.debug(
      `lazyPageWorker: prefetched ${pages.size}/${n} page(s) in ${(performance.now() - start).toFixed(1)}ms`,
    );
  }

  async function handleFetch(pageNo: number): Promise<void> {
    const cached = cacheGet(pageNo);
    if (cached !== undefined) {
      fetchCount++;
      log.debug(
        `lazyPageWorker: served page ${pageNo} (#${fetchCount}) from cache`,
      );
      respond(STATUS_OK, cached);
      return;
    }
    // Logged before, not just after, store.fetchPage: that call does an
    // @instantdb/admin db.query() (resolving pages.path for this pageNo/
    // version) *before* ever reaching R2Client.getObject's own issuing/done
    // logs -- without a log here, a slow/stuck admin-SDK query looks
    // identical to total silence, since the code never even gets to R2.
    log.debug(
      `lazyPageWorker: fetching page ${pageNo} (#${fetchCount + 1})...`,
    );
    try {
      const start = performance.now();
      const bytes = await store.fetchPage(pageNo, snapshot);
      fetchCount++;
      cacheSet(pageNo, bytes);
      log.debug(
        `lazyPageWorker: fetched page ${pageNo} (#${fetchCount}, ${bytes.length}B) in ${(performance.now() - start).toFixed(1)}ms`,
      );
      respond(STATUS_OK, bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(STATUS_ERROR, Buffer.from(message, "utf8"));
    }
  }

  parentPort!.on("message", (msg: FetchMessage) => {
    void handleFetch(msg.pageNo);
  });
  await prefetchFirstPages();
  parentPort!.postMessage({ type: "ready" });
}

void main();
