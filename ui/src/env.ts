// Distinguishes the real browser from Node/Vitest -- both the crypto layer
// (brotli.ts, leancryptoLoader.ts, which load a different build per
// environment) and the data layer (r2.ts, for a CORS-failure hint that only
// makes sense in a browser) need this.
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}
