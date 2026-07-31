// Main-thread side of the worker+Atomics bridge, spawning remotePageWorker.ts
// and exposing the one thing remoteVfs.ts actually needs: a synchronous
// fetchPage(pageNo) it can call from inside SQLite's synchronous xRead
// callback. See remotePageWorker.ts's header for why this indirection
// exists at all (a real network fetch has no synchronous form).
//
// Requires cross-origin isolation (COOP/COEP response headers) for
// SharedArrayBuffer to be available at all -- see docker/README.md's
// local_index.html hosting notes.

// Shared with remotePageWorker.ts's own respond() -- both ends of this
// SharedArrayBuffer protocol must agree on the same indices.
export const CONTROL_STATUS = 0;
export const CONTROL_LEN = 1;
const STATUS_ERROR = 2;
const FETCH_TIMEOUT_MS = 30_000;

export interface RemotePageBridge {
  fetchPage: (pageNo: number) => Uint8Array;
  terminate: () => void;
}

export async function startRemotePageWorker(
  rqliteUrl: string,
  apiKey: string,
  pageSize: number,
  snapshot: number,
  targetDbId?: string,
): Promise<RemotePageBridge> {
  const controlSab = new SharedArrayBuffer(8);
  const dataSab = new SharedArrayBuffer(Math.max(pageSize, 4096) + 4096);
  const control = new Int32Array(controlSab);
  const dataBuf = new Uint8Array(dataSab);

  const worker = new Worker(new URL("./remotePageWorker.ts", import.meta.url), { type: "module" });
  const ready = waitReady(worker);
  worker.postMessage({
    type: "start",
    rqliteUrl,
    apiKey,
    snapshot,
    targetDbId,
    controlSab,
    dataSab,
  });
  await ready;

  return {
    fetchPage: (pageNo) => fetchPageSync(worker, control, dataBuf, pageNo),
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
    worker.addEventListener("error", (ev) => reject(new Error(ev.message)), { once: true });
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
  if (Atomics.wait(control, CONTROL_STATUS, 0, FETCH_TIMEOUT_MS) === "timed-out") {
    throw new Error(`timed out fetching page ${pageNo}`);
  }
  const status = Atomics.load(control, CONTROL_STATUS);
  const bytes = dataBuf.slice(0, Atomics.load(control, CONTROL_LEN));
  if (status === STATUS_ERROR) throw new Error(new TextDecoder().decode(bytes));
  return bytes;
}
