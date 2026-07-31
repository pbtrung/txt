// Browser port of txt/remotePageWorker.ts -- runs as a real Worker (not
// node:worker_threads). Bridges remoteVfs.ts's synchronous xRead callback to
// a real async fetch: the main thread blocks in Atomics.wait() on
// controlSab while this worker does the actual READ_PAGE HTTP round trip
// and wakes it back up. See remotePageClient.ts for the main-thread side of
// this protocol.
//
// target_db_id is threaded through from dbWorker.ts's resolveTargetDbId
// (rqliteHttpClient.ts), same as txt/remotePageWorker.ts's admin-acting-as-
// a-tenant support -- this app's own account is itself role='admin' (the
// sole account --migrate creates), so READ_PAGE needs it named explicitly
// just like GET_META/COMMIT do (see docker/auth_perms.lua). It's still
// undefined for a genuine user-role key, which the server forces to its
// own db_id regardless.

import { verbose } from "../log";
import { RqliteHttpClient, resultRows, decodeBlobColumn } from "./rqliteHttpClient";

interface StartMessage {
  type: "start";
  rqliteUrl: string;
  apiKey: string;
  snapshot: number;
  targetDbId?: string;
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
let targetDbId: string | undefined;
// Diagnostic only -- every READ_PAGE round trip is a real, uncached network
// request (remoteVfs.ts's own pageCache lives on the main-thread side of
// this bridge, not here), so a slow "Loading your books..." unlock phase
// often means many of these firing one at a time rather than one slow
// request -- logging each one's timing/count makes that visible instead of
// only seeing the phase's total elapsed time.
let fetchCount = 0;

self.onmessage = (ev: MessageEvent<StartMessage | FetchMessage>) => {
  const msg = ev.data;
  if (msg.type === "start") {
    client = new RqliteHttpClient(msg.rqliteUrl, msg.apiKey);
    control = new Int32Array(msg.controlSab);
    dataBuf = new Uint8Array(msg.dataSab);
    snapshot = msg.snapshot;
    targetDbId = msg.targetDbId;
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
  const start = performance.now();
  const batch = [{ page_no: pageNo, snapshot }];
  const extra = targetDbId !== undefined ? { target_db_id: targetDbId } : {};
  const row = resultRows(await client.query("READ_PAGE", batch, extra))[0];
  if (!row) throw new Error(`page ${pageNo} not found at or before snapshot ${snapshot}`);
  const bytes = decodeBlobColumn(row[0]);
  fetchCount++;
  verbose(
    `remotePageWorker: fetched page ${pageNo} (#${fetchCount}, ${bytes.length}B) in ` +
      `${(performance.now() - start).toFixed(1)}ms`,
  );
  return bytes;
}

function respond(status: number, bytes: Uint8Array): void {
  const n = Math.min(bytes.length, dataBuf.length);
  dataBuf.set(bytes.subarray(0, n), 0);
  Atomics.store(control, 1, n);
  Atomics.store(control, 0, status);
  Atomics.notify(control, 0);
}
