// Shared by d1Logging.ts and index.ts.
//
// formatMeasuredMs() is for a duration this codebase measured itself via
// performance.now() (D1QueryLog.durationMs, RequestTiming.networkWaitMs,
// and index.ts's cpu_ms/wait_ms/db_ms/network_ms derived from them).
// Empirically confirmed against this project's own workerd runtime (200k
// consecutive same-tick performance.now() calls): its clock is quantized
// to whole milliseconds -- the smallest observed non-zero delta was
// exactly 1, never a fraction. This is a deliberate Spectre-style
// timing-attack mitigation (the same reason browsers coarsen
// performance.now() for cross-origin content), not a bug here or a gap
// in this file's own math. A plain two-decimal format is what that
// resolution actually supports; showing more decimals on an
// integer-quantized "0.00" would only imply a sub-millisecond fraction
// that was never there to measure.
export function formatMeasuredMs(ms: number): string {
  return ms.toFixed(2);
}

// formatReportedMs() is for a duration D1's own infrastructure reported
// (D1QueryLog.d1ReportedMs, from meta.duration) -- not limited by this
// Worker's own performance.now() resolution, so a value genuinely can
// carry sub-millisecond precision. Falling back to six decimal places
// only when two would already show a flat "0.00" keeps the common case
// readable while still surfacing a real, if tiny, non-zero duration.
export function formatReportedMs(ms: number): string {
  const twoDecimals = ms.toFixed(2);
  return twoDecimals === "0.00" ? ms.toFixed(6) : twoDecimals;
}
