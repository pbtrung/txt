// The one server component this design needs (docs/r2_credentials.md) --
// everything else is a direct client-to-InstantDB or client-to-R2 call. This
// Worker's only job is to verify a Firebase-signed identity and, in return,
// mint a short-lived read-only R2 credential scoped to the requested
// document prefix in the Worker-configured bucket. It never talks to
// InstantDB, never sees plaintext page content, and never sees any account's
// umk/txtKey/txtPartKey. Applies to every account, admin included -- there is
// no reason for the admin's own static read-write R2 key to ever reach a
// browser either, since this same broker covers it just as well as a
// `user`-role account.
//
// Deployed as a real Worker script (wrangler.jsonc's `main`) alongside the
// static site (wrangler.jsonc's `assets` binding) rather than as classic
// Cloudflare Pages Functions -- this project's actual Cloudflare resource
// is the newer unified "Workers with static assets" product, which needs a
// single fetch handler that dispatches API routes itself and falls through
// to env.ASSETS.fetch() for everything else, not a functions/ directory.
import { handleR2Creds } from "./r2Creds";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/r2-creds") {
      return handleR2Creds(request, env);
    }
    // env.ASSETS is only ever missing if this Worker was deployed some way
    // other than `wrangler deploy` reading wrangler.jsonc's own `assets`
    // block (e.g. code pasted into the Cloudflare dashboard's Quick Edit
    // editor, which doesn't wire up bindings at all) -- surfaced here as a
    // clear error instead of a bare "Cannot read properties of undefined
    // (reading 'fetch')".
    if (!env.ASSETS) {
      return new Response(
        "This Worker's assets binding is missing -- deploy it with " +
          "`npm run deploy` (wrangler.jsonc's own config), not by pasting " +
          "code into the dashboard's Quick Edit editor.",
        { status: 500 },
      );
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
