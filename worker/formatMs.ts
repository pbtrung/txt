// Shared by d1Logging.ts and index.ts. Two decimal places is normally
// plenty of precision for a millisecond duration, but rounds a lot of
// genuinely-fast operations down to a flat "0.00" -- indistinguishable
// from "this wasn't measured" or a bug. Falling back to six decimal
// places only when two would already show zero keeps the common case
// readable while still surfacing a real, if tiny, non-zero duration.
export function formatMs(ms: number): string {
  const twoDecimals = ms.toFixed(2);
  return twoDecimals === "0.00" ? ms.toFixed(6) : twoDecimals;
}
