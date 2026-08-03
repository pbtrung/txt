// Main-thread side of the worker+Atomics bridge, spawning lazyPageWorker.ts
// and exposing the one thing lazyVfs.ts actually needs: a synchronous
// fetchPage(pageNo) it can call from inside SQLite's synchronous xRead
// callback. See lazyPageWorker.ts's header for why this indirection exists
// at all (a real network fetch has no synchronous form, and the vendored
// WASM build has no Asyncify support -- CLAUDE.md's own confirmed
// constraint) and why it's simpler here than the browser original it's
// ported from (ui/src/data/remotePageClient.ts).
import { Worker } from "node:worker_threads";
import type { R2ConfigResolved } from "./creds.ts";
import {
  CONTROL_LEN,
  CONTROL_STATUS,
  STATUS_ERROR,
  type LazyPageWorkerData,
} from "./lazyPageProtocol.ts";
import type { Logger } from "./logger.ts";

const FETCH_TIMEOUT_MS = 30_000;

export interface LazyPageBridge {
  fetchPage: (pageNo: number) => Buffer;
  terminate: () => Promise<number>;
}

export interface LazyPageWorkerConfig {
  instantAppId: string;
  instantAdminToken: string;
  r2Config: R2ConfigResolved;
  pathKey: Buffer;
  authId: string;
  snapshot: number;
  pageCount: number;
  pageSize: number;
  verbose: boolean;
}

export async function startLazyPageWorker(
  cfg: LazyPageWorkerConfig,
  log: Logger,
): Promise<LazyPageBridge> {
  const controlSab = new SharedArrayBuffer(8);
  const dataSab = new SharedArrayBuffer(Math.max(cfg.pageSize, 4096) + 4096);
  const control = new Int32Array(controlSab);
  const dataBuf = new Uint8Array(dataSab);

  const workerData: LazyPageWorkerData = {
    instantAppId: cfg.instantAppId,
    instantAdminToken: cfg.instantAdminToken,
    r2Config: cfg.r2Config,
    pathKey: cfg.pathKey.toString("base64"),
    authId: cfg.authId,
    snapshot: cfg.snapshot,
    pageCount: cfg.pageCount,
    verbose: cfg.verbose,
    controlSab,
    dataSab,
  };
  const worker = new Worker(new URL("./lazyPageWorker.ts", import.meta.url), {
    workerData,
  });
  await waitReady(worker);

  return {
    fetchPage: (pageNo) => fetchPageSync(worker, control, dataBuf, pageNo, log),
    terminate: () => worker.terminate(),
  };
}

function waitReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type !== "ready") return;
      worker.off("message", onMessage);
      resolve();
    };
    worker.on("message", onMessage);
    worker.once("error", (err) => reject(err));
  });
}

// Atomics.wait() below blocks this *entire* thread, not just JS execution --
// while it's blocked, the worker's own console.log calls (relayed back over
// an internal message channel this thread's event loop has to process)
// physically cannot reach the terminal, even though they already fired
// inside the worker. Logging here, immediately before the block starts, is
// the only way to show real-time progress during that window -- otherwise a
// page fetch that takes a while looks indistinguishable from a genuine hang
// until the block ends and every queued worker log line lands at once.
function fetchPageSync(
  worker: Worker,
  control: Int32Array,
  dataBuf: Uint8Array,
  pageNo: number,
  log: Logger,
): Buffer {
  Atomics.store(control, CONTROL_STATUS, 0);
  worker.postMessage({ type: "fetch", pageNo });
  log.debug(`lazyPageClient: blocking on page ${pageNo}...`);
  if (
    Atomics.wait(control, CONTROL_STATUS, 0, FETCH_TIMEOUT_MS) === "timed-out"
  ) {
    throw new Error(`timed out fetching page ${pageNo}`);
  }
  const status = Atomics.load(control, CONTROL_STATUS);
  const bytes = Buffer.from(
    dataBuf.subarray(0, Atomics.load(control, CONTROL_LEN)),
  );
  if (status === STATUS_ERROR) throw new Error(bytes.toString("utf8"));
  return bytes;
}
