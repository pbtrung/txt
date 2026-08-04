// Distinguishes the real browser from Node/Vitest -- both the crypto layer
// (brotli.ts, data/leancrypto.ts, which load a different build per
// environment) and the data layer (r2.ts, for a CORS-failure hint that only
// makes sense in a browser) need this.
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

// Also true inside a Worker, unlike isBrowser() (a Worker has no window/
// document at all) -- this app has no Worker of its own anymore (there's no
// SQLite/VFS bridge left to run inside one), but data/leancrypto.ts's
// fetch+verify+blob-import loading path works identically on the main
// thread and inside a Worker, unlike under Node, so this stays the more
// correct check to gate that branch on. WorkerGlobalScope is a standard
// global inside every Worker (classic or module) and is never defined by
// Node, so this stays reliable even as Node adds more individual
// web-platform globals (fetch, navigator, ...) over time.
export function isWeb(): boolean {
  return (
    isBrowser() ||
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
      "undefined"
  );
}
