// docs/auth.md's Firebase-ID-token-to-Turso-token exchange. Deployed as a
// plain Worker script (no static assets binding here -- this repo's
// frontend is a separate build, not served by this Worker).

import { handleDbToken } from "./dbToken";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/db-token") {
      return handleDbToken(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
