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

// Sent by lazyPageClient.ts's updateCommittedPages, right after each of
// migrate.ts's commits succeeds -- pushes that commit's own just-written
// page bytes straight into this cache, no re-fetch involved (this worker
// never otherwise learns about a write at all: xWrite only ever touches
// lazyVfs.ts's own in-memory dirtyPages map on the main thread). Keeps this
// cache from serving a stale copy of a page number this run itself
// overwrote after having prefetched (or on-demand fetched) an older version
// of it earlier in the same run.
interface UpdatePagesMessage {
  type: "update-pages";
  pages: Map<number, Buffer>;
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

  // Unbounded on purpose, not just a one-shot prefetch buffer: the initial
  // prefetch below warms it, but any later on-demand fetch also adds to it,
  // so a page re-read after leaving the prefetch range can still hit this
  // cache instead of paying another round trip. A --migrate run is a
  // single, bounded CLI process (no browser tab memory pressure to worry
  // about) and this never grows past the target account's own page count
  // either way. This one's main value is low-numbered pages (schema page 1,
  // early btree/index pages -- disproportionately likely to be hit early
  // and often regardless of which txt_id/txt_parts rows a given run needs)
  // served from the very first xRead, before they've ever been fetched
  // individually; lazyVfs.ts's own cache on the main thread covers most
  // other repeat reads (getPage checks it before ever calling opts.fetchPage
  // into this worker at all). Never invalidated -- correct only because
  // --migrate is single-writer/strictly sequential and this run's own
  // commits always advance to freshly-allocated page numbers past whatever
  // pageCount was at construction (docs/data_model.md; the same invariant
  // this file's fixed snapshot already relies on).
  const cache = new Map<number, Buffer>();

  // Prefetches every page that exists as of this run's own fixed snapshot
  // (data.pageCount, not some smaller guess) in one batched InstantDB query
  // + batched R2 GETs, before SQLite's own xRead ever asks for a single
  // page. computeResumePlans' index scans over an existing, possibly large
  // target account would otherwise pay a full query+GET round trip per
  // page, one at a time, serially -- and since this cache is unbounded
  // (never evicted), prefetching everything up front means virtually every
  // later read this run makes is a cache hit, not just the low-numbered
  // pages a smaller guess would have covered. Pages created *after* this
  // run's own construction (i.e. by this run's own commits) aren't fetched
  // here at all -- they arrive via updateCommittedPages below instead.
  async function prefetchAllPages(): Promise<void> {
    const n = data.pageCount;
    if (n <= 0) return;
    const pageNos = Array.from({ length: n }, (_, i) => i + 1);
    const start = performance.now();
    const pages = await store.fetchPagesBatch(pageNos, snapshot);
    for (const [pageNo, bytes] of pages) cache.set(pageNo, bytes);
    log.debug(
      `lazyPageWorker: prefetched ${pages.size}/${n} page(s) in ${(performance.now() - start).toFixed(1)}ms`,
    );
  }

  async function handleFetch(pageNo: number): Promise<void> {
    const cached = cache.get(pageNo);
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
      cache.set(pageNo, bytes);
      log.debug(
        `lazyPageWorker: fetched page ${pageNo} (#${fetchCount}, ${bytes.length}B) in ${(performance.now() - start).toFixed(1)}ms`,
      );
      respond(STATUS_OK, bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(STATUS_ERROR, Buffer.from(message, "utf8"));
    }
  }

  parentPort!.on("message", (msg: FetchMessage | UpdatePagesMessage) => {
    if (msg.type === "update-pages") {
      for (const [pageNo, bytes] of msg.pages) cache.set(pageNo, bytes);
      log.debug(
        `lazyPageWorker: cached ${msg.pages.size} newly-committed page(s)`,
      );
      return;
    }
    void handleFetch(msg.pageNo);
  });
  await prefetchAllPages();
  parentPort!.postMessage({ type: "ready" });
}

void main();
