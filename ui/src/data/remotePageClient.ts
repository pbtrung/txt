// Main-thread side of the worker+Atomics bridge, spawning remotePageWorker.ts
// and exposing the one thing remoteVfs.ts actually needs: a synchronous
// fetchPage(pageNo) it can call from inside SQLite's synchronous xRead
// callback. See remotePageWorker.ts's header for why this indirection
// exists at all (a real network fetch has no synchronous form).
//
// Requires cross-origin isolation (COOP/COEP response headers) for
// SharedArrayBuffer to be available at all -- see ui/vite.config.ts's dev/
// preview header config and build-integrity.mjs's dist/_headers for the
// real deployment.

import type { R2Config } from "./r2Config";

// Shared with remotePageWorker.ts's own respond() -- both ends of this
// SharedArrayBuffer protocol must agree on the same indices.
export const CONTROL_STATUS = 0;
export const CONTROL_LEN = 1;
const STATUS_ERROR = 2;
const FETCH_TIMEOUT_MS = 30_000;

export interface RemotePageBridge {
  fetchPage: (pageNo: number) => Uint8Array;
  /** Advances the snapshot version this worker's READ_PAGE fetches pin --
   * must be called after every successful commit() (remoteVfs.ts), or a
   * live fetch for a page that only exists as of the new version (freshly
   * written this session, evicted from the cache or never cached at all)
   * would come back "not found" against the stale snapshot this worker
   * started with. */
  updateSnapshot: (newSnapshot: number) => void;
  terminate: () => void;
}

export interface RemotePageWorkerAuth {
  instantAppId: string;
  instantClientName: string;
  idToken: string;
  r2Config: R2Config;
  pathKey: Uint8Array;
  authId: string;
  ownerId: string;
}

export async function startRemotePageWorker(
  auth: RemotePageWorkerAuth,
  pageSize: number,
  snapshot: number,
): Promise<RemotePageBridge> {
  const controlSab = new SharedArrayBuffer(8);
  const dataSab = new SharedArrayBuffer(Math.max(pageSize, 4096) + 4096);
  const control = new Int32Array(controlSab);
  const dataBuf = new Uint8Array(dataSab);

  const worker = new Worker(new URL("./remotePageWorker.ts", import.meta.url), {
    type: "module",
  });
  const ready = waitReady(worker);
  worker.postMessage({
    type: "start",
    ...auth,
    snapshot,
    controlSab,
    dataSab,
  });
  await ready;

  return {
    fetchPage: (pageNo) => fetchPageSync(worker, control, dataBuf, pageNo),
    updateSnapshot: (newSnapshot) =>
      worker.postMessage({ type: "update-snapshot", newSnapshot }),
    terminate: () => worker.terminate(),
  };
}

function waitReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent<{ type?: string }>) => {
      if (ev.data?.type !== "ready") return;
      worker.removeEventListener("message", onMessage);
      resolve();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", (ev) => reject(new Error(ev.message)), {
      once: true,
    });
  });
}

function fetchPageSync(
  worker: Worker,
  control: Int32Array,
  dataBuf: Uint8Array,
  pageNo: number,
): Uint8Array {
  Atomics.store(control, CONTROL_STATUS, 0);
  worker.postMessage({ type: "fetch", pageNo });
  if (
    Atomics.wait(control, CONTROL_STATUS, 0, FETCH_TIMEOUT_MS) === "timed-out"
  ) {
    throw new Error(`timed out fetching page ${pageNo}`);
  }
  const status = Atomics.load(control, CONTROL_STATUS);
  const bytes = dataBuf.slice(0, Atomics.load(control, CONTROL_LEN));
  if (status === STATUS_ERROR) throw new Error(new TextDecoder().decode(bytes));
  return bytes;
}
