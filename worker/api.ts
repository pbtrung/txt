// The /v1/* route table. docs/auth.md's Access-gating and
// proof-of-possession requirements are enforced by Cloudflare Access at the
// edge (§1/§2) and by later milestones' route handlers (docs/milestones.md)
// -- this module only owns routing and the routes implemented so far.
//
// `Env` is the global ambient type `wrangler types` generates from
// wrangler.jsonc's bindings (worker/worker-configuration.d.ts) -- not
// imported, since it isn't exported from anywhere; regenerate that file
// (`npm run worker:typecheck` does this first) after changing a binding.
type Handler = (request: Request, env: Env, url: URL) => Promise<Response> | Response;

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/v1/health": {
    GET: () => Response.json({ status: "ok" }),
  },
};

export function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> | Response {
  const route = ROUTES[url.pathname];
  if (!route) {
    return new Response("Not Found", { status: 404 });
  }
  const handler = route[request.method];
  if (!handler) {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return handler(request, env, url);
}
