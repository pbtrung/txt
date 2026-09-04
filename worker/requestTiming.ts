// Cloudflare bills Workers by CPU time, which explicitly excludes time
// spent waiting on I/O -- network subrequests, D1 queries, any external
// service call (docs/deployment.md §8: "Workers CPU time ... 10 ms /
// invocation"). There's no runtime API that hands back Cloudflare's own
// internal CPU accounting directly, so index.ts approximates it the same
// way that billing definition implies: measure this request's total
// wall-clock time, subtract every I/O wait this module and d1Logging.ts
// know about, and treat the remainder as CPU time.
//
// D1 wait is already known per query (d1Logging.ts's D1QueryLog.durationMs,
// summed by index.ts). This module covers everything else: right now
// that's just the Access JWKS fetch (worker/api.ts's fetchJwks) -- the
// only other place this codebase makes an outbound fetch() of its own,
// and one that's cache-hit (no network call at all) on all but roughly
// one request per hour (JWKS_CACHE_TTL_MS).

export interface RequestTiming {
  networkWaitMs: number;
}

export function createRequestTiming(): RequestTiming {
  return { networkWaitMs: 0 };
}

export async function timeNetwork<T>(
  timing: RequestTiming,
  operation: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await operation();
  } finally {
    timing.networkWaitMs += performance.now() - start;
  }
}
