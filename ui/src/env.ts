// Distinguishes the real browser from Node/Vitest -- both the crypto layer
// (brotli.ts, data/leancrypto.ts, which load a different build per
// environment) and the data layer (r2.ts, for a CORS-failure hint that only
// makes sense in a browser) need this.
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

// Also true inside a browser Worker, unlike isBrowser() (a Worker has no
// window/document at all). ui/ does not currently ship its own browser
// Worker bundle, but data/leancrypto.ts's fetch+verify+blob-import loading
// path works the same on the main thread and inside a Worker, unlike under
// Node, so this stays the right gate for that branch. WorkerGlobalScope is a
// standard Worker global and is never defined by Node, so this stays reliable
// even as Node adds more web-platform globals over time.
export function isWeb(): boolean {
  return (
    isBrowser() ||
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
      "undefined"
  );
}
