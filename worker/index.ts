// docs/auth.md's Firebase-ID-token-to-key-material exchange, plus R2 temp
// credential minting. wrangler.jsonc's own "assets" block serves ui/'s
// built static files alongside this script -- requests under /v1/* reach
// this fetch handler, everything else is served (or SPA-fallback-served)
// from dist/ without ever invoking it.

import { handleKeys } from "./keys";
import { handleR2Token } from "./r2Token";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/keys") {
      return handleKeys(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/r2-token") {
      return handleR2Token(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
