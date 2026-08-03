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

  async function handleFetch(pageNo: number): Promise<void> {
    try {
      const start = performance.now();
      const bytes = await store.fetchPage(pageNo, snapshot);
      fetchCount++;
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
  parentPort!.postMessage({ type: "ready" });
}

void main();
