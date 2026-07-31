// Main-thread side of the worker+Atomics bridge, spawning remotePageWorker.ts
// and exposing the one thing remoteVfs.ts actually needs: a synchronous
// fetchPage(pageNo) it can call from inside SQLite's synchronous xRead
// callback. See remotePageWorker.ts's header for why this indirection
// exists at all (a real network fetch has no synchronous form). Shared by
// every command that opens a real remote database lazily (TestPerfCommand,
// TestWriteCommand) -- this used to be duplicated inline in TestPerfCommand.

import { Worker } from "node:worker_threads";

const CONTROL_STATUS = 0;
const CONTROL_LEN = 1;
const STATUS_ERROR = 2;
const FETCH_TIMEOUT_MS = 30_000;

export interface RemotePageBridge {
  fetchPage: (pageNo: number) => Uint8Array;
  terminate: () => Promise<void>;
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
  const worker = new Worker(new URL("./remotePageWorker.ts", import.meta.url), {
    workerData: { rqliteUrl, apiKey, targetDbId, snapshot, controlSab, dataSab },
  });
  await waitReady(worker);
  return {
    fetchPage: (pageNo) => fetchPageSync(worker, control, dataBuf, pageNo),
    terminate: () => worker.terminate().then(() => undefined),
  };
}

function waitReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once("message", (msg: { type?: string }) => {
      if (msg?.type === "ready") resolve();
      else reject(new Error("unexpected first message from remote-page worker"));
    });
    worker.once("error", reject);
  });
}

function fetchPageSync(
  worker: Worker,
  control: Int32Array,
  dataBuf: Uint8Array,
  pageNo: number,
): Uint8Array {
  Atomics.store(control, CONTROL_STATUS, 0);
  worker.postMessage({ pageNo });
  if (Atomics.wait(control, CONTROL_STATUS, 0, FETCH_TIMEOUT_MS) === "timed-out") {
    throw new Error(`timed out fetching page ${pageNo}`);
  }
  const status = Atomics.load(control, CONTROL_STATUS);
  const bytes = dataBuf.slice(0, Atomics.load(control, CONTROL_LEN));
  if (status === STATUS_ERROR) throw new Error(Buffer.from(bytes).toString("utf8"));
  return bytes;
}
