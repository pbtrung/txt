// Runs on a worker thread, spawned by remoteVfs.ts. Exists solely to bridge
// a synchronous WASM VFS callback (xRead, called directly by SQLite's C
// code -- no await path across that boundary) to a real async HTTP fetch:
// the main thread blocks on Atomics.wait() while this worker does the
// actual network round trip and wakes it back up. See remoteVfs.ts for the
// main-thread side of this protocol.

import { parentPort, workerData } from "node:worker_threads";
import { RqliteHttpClient, resultRows, decodeBlobColumn } from "./rqliteHttpClient.ts";

interface WorkerData {
  rqliteUrl: string;
  apiKey: string;
  /** Required if apiKey resolves to role='admin' -- see PerfCreds.target_db_id. */
  targetDbId?: string;
  snapshot: number;
  controlSab: SharedArrayBuffer;
  dataSab: SharedArrayBuffer;
}

const STATUS_OK = 1;
const STATUS_ERROR = 2;

if (!parentPort) throw new Error("remotePageWorker.ts must run inside a worker thread");

const data = workerData as WorkerData;
const control = new Int32Array(data.controlSab);
const dataBuf = new Uint8Array(data.dataSab);
const client = new RqliteHttpClient(data.rqliteUrl, data.apiKey);

parentPort.on("message", (msg: { pageNo: number }) => {
  void handleRequest(msg.pageNo);
});
parentPort.postMessage({ type: "ready" });

async function handleRequest(pageNo: number): Promise<void> {
  try {
    respond(STATUS_OK, await fetchPage(pageNo));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    respond(STATUS_ERROR, Buffer.from(message, "utf8"));
  }
}

async function fetchPage(pageNo: number): Promise<Buffer> {
  const extra = data.targetDbId ? { target_db_id: data.targetDbId } : {};
  const batch = [{ page_no: pageNo, snapshot: data.snapshot }];
  const row = resultRows(await client.query("READ_PAGE", batch, extra))[0];
  if (!row) throw new Error(`page ${pageNo} not found at or before snapshot ${data.snapshot}`);
  return decodeBlobColumn(row[0]);
}

function respond(status: number, bytes: Buffer): void {
  const n = Math.min(bytes.length, dataBuf.length);
  dataBuf.set(bytes.subarray(0, n), 0);
  Atomics.store(control, 1, n);
  Atomics.store(control, 0, status);
  Atomics.notify(control, 0);
}
