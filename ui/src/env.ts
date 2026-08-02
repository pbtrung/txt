// Distinguishes the real browser from Node/Vitest -- both the crypto layer
// (brotli.ts, wasmLoader.ts, which load a different build per environment)
// and the data layer (r2.ts, for a CORS-failure hint that only makes sense
// in a browser) need this.
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

// True on the main thread AND inside a Worker (dbWorker.ts, remotePageWorker.ts)
// -- unlike isBrowser(), which is main-thread-only (a Worker has no
// window/document at all). WorkerGlobalScope is a standard global inside
// every Worker (classic or module) and is never defined by Node, so this
// stays reliable even as Node adds more individual web-platform globals
// (fetch, navigator, ...) over time. wasmLoader.ts needs this distinction:
// its fetch+verify+blob-import loading path works identically on the main
// thread and inside a Worker, but not under Node.
export function isWeb(): boolean {
  return (
    isBrowser() ||
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
      "undefined"
  );
}
