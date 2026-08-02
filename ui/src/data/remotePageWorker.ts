// Runs as a real Worker (not node:worker_threads). Bridges remoteVfs.ts's
// synchronous xRead callback to a real async fetch: the main thread blocks
// in Atomics.wait() on controlSab while this worker does the actual
// InstantDB query + R2 GET and wakes it back up. See remotePageClient.ts
// for the main-thread side of this protocol.
//
// This worker needs its own InstantDB session -- a Worker can't share a
// live JS object (an InstantDB client instance, an AwsClient) with the main
// thread across postMessage, only structured-cloneable data, so it
// re-establishes its own session from the same Firebase idToken the main
// thread already used (db.auth.signInWithIdToken() a second time, against a
// fresh init() instance). That idToken is a validated, still-fresh Firebase
// credential at the point unlock() hands it over; InstantDB's own session
// then manages its own refresh from there, same as the main thread's.

import { createInstantClient } from "./instantClient";
import {
  fetchPage as fetchPageFromStore,
  type InstantPageStoreConfig,
} from "./instantPageStore";
import { CONTROL_STATUS, CONTROL_LEN } from "./remotePageClient";
import type { R2Config } from "./r2Config";
import { fetchTempR2Credential } from "./tempR2Creds";
import { verbose } from "../log";

// worker/r2Creds.ts's own TTL_SECONDS is 900s (15 minutes) -- refreshed at
// a comfortable margin before that, same reasoning as dbWorker.ts's own
// R2_CRED_REFRESH_INTERVAL_MS.
const R2_CRED_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

interface StartMessage {
  type: "start";
  instantAppId: string;
  instantClientName: string;
  idToken: string;
  r2Config: R2Config;
  pathKey: Uint8Array;
  authId: string;
  ownerId: string;
  snapshot: number;
  controlSab: SharedArrayBuffer;
  dataSab: SharedArrayBuffer;
}

interface FetchMessage {
  type: "fetch";
  pageNo: number;
}

interface UpdateSnapshotMessage {
  type: "update-snapshot";
  newSnapshot: number;
}

const STATUS_OK = 1;
const STATUS_ERROR = 2;

let cfg: InstantPageStoreConfig;
let control: Int32Array;
let dataBuf: Uint8Array;
let snapshot: number;
// Kept around so the R2 credential refresh timer below can re-mint one
// without the main thread having to resend them.
let storedIdToken: string;
let storedAuthId: string;
// Diagnostic only -- every fetch here is a real, uncached query+R2 GET
// (remoteVfs.ts's own pageCache lives on the main-thread side of this
// bridge, not here), so a slow "Loading your books..." unlock phase often
// means many of these firing one at a time rather than one slow request --
// logging each one's timing/count makes that visible instead of only
// seeing the phase's total elapsed time.
let fetchCount = 0;

self.onmessage = async (
  ev: MessageEvent<StartMessage | FetchMessage | UpdateSnapshotMessage>,
) => {
  const msg = ev.data;
  if (msg.type === "start") {
    await start(msg);
    self.postMessage({ type: "ready" });
    return;
  }
  if (msg.type === "update-snapshot") {
    verbose(`remotePageWorker: snapshot ${snapshot} -> ${msg.newSnapshot}`);
    snapshot = msg.newSnapshot;
    return;
  }
  void handleFetch(msg.pageNo);
};

async function start(msg: StartMessage): Promise<void> {
  const db = createInstantClient(msg.instantAppId);
  await db.auth.signInWithIdToken({
    clientName: msg.instantClientName,
    idToken: msg.idToken,
  });
  storedIdToken = msg.idToken;
  storedAuthId = msg.authId;
  const r2Cred = await fetchTempR2Credential(
    msg.idToken,
    msg.authId,
    msg.r2Config,
  );
  cfg = {
    db,
    r2Client: r2Cred.client,
    r2Config: msg.r2Config,
    pathKey: msg.pathKey,
    authId: msg.authId,
    ownerId: msg.ownerId,
  };
  control = new Int32Array(msg.controlSab);
  dataBuf = new Uint8Array(msg.dataSab);
  snapshot = msg.snapshot;
  setInterval(() => void refreshR2Credential(), R2_CRED_REFRESH_INTERVAL_MS);
}

async function refreshR2Credential(): Promise<void> {
  const r2Cred = await fetchTempR2Credential(
    storedIdToken,
    storedAuthId,
    cfg.r2Config,
  );
  cfg.r2Client = r2Cred.client;
  verbose("remotePageWorker: refreshed temporary R2 credential");
}

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
  const bytes = await fetchPageFromStore(cfg, pageNo, snapshot);
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
  Atomics.store(control, CONTROL_LEN, n);
  Atomics.store(control, CONTROL_STATUS, status);
  Atomics.notify(control, CONTROL_STATUS);
}
