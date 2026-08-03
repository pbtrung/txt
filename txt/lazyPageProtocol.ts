// Shared by lazyPageClient.ts (main thread) and lazyPageWorker.ts (the
// node:worker_threads Worker it spawns) -- both ends of this
// SharedArrayBuffer protocol must agree on the same indices/status codes.
// Ported from ui/src/data/remotePageClient.ts's/remotePageWorker.ts's own
// bridge, which duplicates these constants across two files since a
// browser Worker can't easily share a module with the main thread the way
// a bundled build's import graph usually implies; node:worker_threads has
// no such constraint, so this is one shared module instead.
//
// controlSab is a SharedArrayBuffer(8), viewed as an Int32Array with two
// slots: CONTROL_STATUS (the Atomics.wait/notify target -- 0 while a fetch
// is pending, STATUS_OK/STATUS_ERROR once the worker has responded) and
// CONTROL_LEN (how many bytes of the separate dataSab buffer are valid for
// this response). Real page bytes (or, on error, the UTF-8 error message)
// are written directly into dataSab by the worker, never passed through
// postMessage/structured clone.
export const CONTROL_STATUS = 0;
export const CONTROL_LEN = 1;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;

// lazyPageClient.ts's startLazyPageWorker builds this as lazyPageWorker.ts's
// `workerData`.
export interface LazyPageWorkerData {
  instantAppId: string;
  instantAdminToken: string;
  r2Config: import("./creds.ts").R2ConfigResolved;
  pathKey: string; // base64
  authId: string;
  snapshot: number;
  verbose: boolean;
  controlSab: SharedArrayBuffer;
  dataSab: SharedArrayBuffer;
}
