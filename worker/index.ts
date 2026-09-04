// One Worker serves the whole host (docs/deployment.md §1): /v1/* runs the
// API, everything else falls through to the static assets binding.
//
// Requests are routed explicitly here by path prefix, rather than relying
// on Wrangler's default asset-first routing (assets checked before the
// Worker's own fetch() runs): explicit routing makes it impossible for a
// future static asset that happens to be named e.g. dist/v1/health to
// shadow the real /v1/health route, and keeps the routing decision in one
// place that's easy to test directly.
//
// `Env` is the global ambient type `wrangler types` generates from
// wrangler.jsonc's bindings (worker/worker-configuration.d.ts).
import { handleApi } from "./api";
import { withD1QueryLogging, type D1QueryLog } from "./d1Logging";
import { createRequestTiming } from "./requestTiming";

function sumDurationMs(queries: D1QueryLog[]): number {
  return queries.reduce((sum, query) => sum + query.durationMs, 0);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) {
      return env.ASSETS.fetch(request);
    }
    // Fresh per request, never module-level state: this isolate can be
    // handling other requests concurrently, and shared state would mix
    // one request's timing/queries into another's.
    const queries: D1QueryLog[] = [];
    const timing = createRequestTiming();
    const start = performance.now();
    const response = await handleApi(
      request,
      { ...env, DB: withD1QueryLogging(env.DB, queries) },
      url,
      timing,
    );
    const totalMs = performance.now() - start;
    const dbWaitMs = sumDurationMs(queries);
    const waitMs = dbWaitMs + timing.networkWaitMs;
    // Cloudflare bills Workers by CPU time, which excludes I/O wait
    // (worker/requestTiming.ts) -- clamped to 0 since this is measured
    // wall-clock time minus measured wait, not Cloudflare's own internal
    // accounting, and either can be individually noisy at sub-millisecond
    // scale.
    const cpuMs = Math.max(0, totalMs - waitMs);
    console.log(
      "Worker CPU time:",
      JSON.stringify({ path: url.pathname, cpu_ms: cpuMs.toFixed(2) }),
    );
    console.log(
      "Worker wait time:",
      JSON.stringify({
        path: url.pathname,
        wait_ms: waitMs.toFixed(2),
        db_ms: dbWaitMs.toFixed(2),
        network_ms: timing.networkWaitMs.toFixed(2),
      }),
    );
    return response;
  },
} satisfies ExportedHandler<Env>;
