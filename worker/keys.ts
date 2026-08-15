// docs/auth.md §4.1/§5: POST /v1/keys. Verifies the caller's Firebase ID
// token, resolves their ctl row (through the KV cache and rate limit §6
// describes), and returns their wrapped umk and cred_store backup --
// still ciphertext, since the Worker never holds an encryption key.

import type { AccountLookup } from "./account";
import { getAccount } from "./account";
import { verifiedUid } from "./auth";

export async function handleKeys(request: Request, env: Env): Promise<Response> {
  const uid = await verifiedUid(request, env.FIREBASE_PROJECT_ID);
  if (uid === null)
    return new Response("missing or invalid bearer token", { status: 401 });
  return respond(await getAccount(env, uid));
}

function respond(result: AccountLookup): Response {
  switch (result.status) {
    case "ok":
      return Response.json({
        type: result.account.type,
        umk: result.account.umk,
        cred_store: result.account.credStoreContent,
      });
    case "rate_limited":
      return new Response("rate limit exceeded", { status: 429 });
    case "not_provisioned":
      return new Response("not provisioned", { status: 403 });
    case "unavailable":
      return new Response("ctl unavailable", { status: 503 });
  }
}
