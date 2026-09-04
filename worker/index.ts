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
import { withD1QueryLogging } from "./d1Logging";

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/v1/")) {
      return handleApi(request, { ...env, DB: withD1QueryLogging(env.DB) }, url);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
