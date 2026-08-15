// jsdom (Vitest's jsdom test environment) defines both window and document
// but never executes injected <script> tags, so sqlcipherLoader.ts's
// browser-loading path would hang forever waiting for an onload that never
// fires. jsdom's own userAgent self-identifies for exactly this reason --
// treat it as Node, not a real browser.
export function isBrowser(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  return !navigator.userAgent.includes("jsdom");
}
