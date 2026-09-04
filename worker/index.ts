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
import { D1_META_HEADER, withD1QueryLogging, type D1QueryLog } from "./d1Logging";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) {
      return env.ASSETS.fetch(request);
    }
    // A fresh array per request, never module-level state: this isolate
    // can be handling other requests concurrently, and a shared array
    // would mix their D1 queries into this response's header.
    const queries: D1QueryLog[] = [];
    const response = await handleApi(
      request,
      { ...env, DB: withD1QueryLogging(env.DB, queries) },
      url,
    );
    const headers = new Headers(response.headers);
    headers.set(D1_META_HEADER, JSON.stringify(queries));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
