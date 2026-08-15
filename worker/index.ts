// docs/auth.md's Firebase-ID-token-to-key-material exchange, plus R2 temp
// credential minting. Deployed as a plain Worker script (no static assets
// binding here -- this repo's frontend is a separate build, not served by
// this Worker).

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
