// docs/auth.md's Firebase-ID-token-to-Turso-token exchange. Deployed as a
// plain Worker script (no static assets binding here -- this repo's
// frontend is a separate build, not served by this Worker).
//
// Route wiring is intentionally minimal for now: verifyFirebaseIdToken
// (firebaseAuth.ts) exists and is tested on its own, but nothing calls it
// yet -- the ctl lookup and Turso token minting it depends on to answer
// docs/auth.md §4's POST /v1/db-token land in the next step.

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
