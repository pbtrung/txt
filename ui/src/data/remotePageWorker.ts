// Browser port of txt/remotePageWorker.ts -- runs as a real Worker (not
// node:worker_threads). Bridges remoteVfs.ts's synchronous xRead callback to
// a real async fetch: the main thread blocks in Atomics.wait() on
// controlSab while this worker does the actual READ_PAGE HTTP round trip
// and wakes it back up. See remotePageClient.ts for the main-thread side of
// this protocol.
//
// No target_db_id here (unlike txt/remotePageWorker.ts's admin-acting-as-
// another-tenant support) -- the browser UI is always the end user reading
// their own vault, never an admin (the Manage screen is out of scope, see
// CLAUDE.md's plan).

import { RqliteHttpClient, resultRows, decodeBlobColumn } from "./rqliteHttpClient";

interface StartMessage {
  type: "start";
  rqliteUrl: string;
  apiKey: string;
  snapshot: number;
  controlSab: SharedArrayBuffer;
  dataSab: SharedArrayBuffer;
}

interface FetchMessage {
  type: "fetch";
  pageNo: number;
}

const STATUS_OK = 1;
const STATUS_ERROR = 2;

let client: RqliteHttpClient;
let control: Int32Array;
let dataBuf: Uint8Array;
let snapshot: number;

self.onmessage = (ev: MessageEvent<StartMessage | FetchMessage>) => {
  const msg = ev.data;
  if (msg.type === "start") {
    client = new RqliteHttpClient(msg.rqliteUrl, msg.apiKey);
    control = new Int32Array(msg.controlSab);
    dataBuf = new Uint8Array(msg.dataSab);
    snapshot = msg.snapshot;
    self.postMessage({ type: "ready" });
    return;
  }
  void handleFetch(msg.pageNo);
};

async function handleFetch(pageNo: number): Promise<void> {
  try {
    respond(STATUS_OK, await fetchPage(pageNo));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    respond(STATUS_ERROR, new TextEncoder().encode(message));
  }
}

async function fetchPage(pageNo: number): Promise<Uint8Array> {
  const batch = [{ page_no: pageNo, snapshot }];
  const row = resultRows(await client.query("READ_PAGE", batch))[0];
  if (!row) throw new Error(`page ${pageNo} not found at or before snapshot ${snapshot}`);
  return decodeBlobColumn(row[0]);
}

function respond(status: number, bytes: Uint8Array): void {
  const n = Math.min(bytes.length, dataBuf.length);
  dataBuf.set(bytes.subarray(0, n), 0);
  Atomics.store(control, 1, n);
  Atomics.store(control, 0, status);
  Atomics.notify(control, 0);
}
