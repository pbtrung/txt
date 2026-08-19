// docs/auth.md §4.1/§5: POST /v1/keys. Verifies the caller's Firebase ID
// token, resolves their ctl row (through the KV cache and rate limit §6
// describes), and returns their wrapped umk, signing private key, and
// cred_store backup -- still ciphertext, since the Worker never holds an
// encryption key.

import type { AccountLookup } from "./account";
import { getAccount } from "./account";
import { verifiedUid } from "./auth";
import { issueR2Ticket } from "./r2Ticket";

export async function handleKeys(request: Request, env: Env): Promise<Response> {
  const uid = await verifiedUid(request, env.FIREBASE_PROJECT_ID);
  if (uid === null)
    return new Response("missing or invalid bearer token", { status: 401 });
  return respond(await getAccount(env, uid), uid, env);
}

async function respond(
  result: AccountLookup,
  uid: string,
  env: Env,
): Promise<Response> {
  switch (result.status) {
    case "ok": {
      try {
        return Response.json({
          type: result.account.type,
          uid,
          umk: result.account.umk,
          signing: {
            version: result.account.signVersion,
            algorithm: result.account.signAlgorithm,
            private_key: result.account.signPrivateKey,
          },
          cred_store: result.account.credStoreContent,
          r2_ticket: await issueR2Ticket(result.account, uid, env.R2_TICKET_SECRET),
        });
      } catch {
        return new Response("ticket signing unavailable", { status: 503 });
      }
    }
    case "rate_limited":
      return new Response("rate limit exceeded", { status: 429 });
    case "not_provisioned":
      return new Response("not provisioned", { status: 403 });
    case "unavailable":
      return new Response("ctl unavailable", { status: 503 });
  }
}
