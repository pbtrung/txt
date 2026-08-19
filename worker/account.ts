// Resolve the Firebase uid used by /v1/keys to its ctl account through the
// cache and keys-specific rate limit. /v1/r2-token verifies a signed ticket
// and never calls ctl.

import { cacheAccount, checkRateLimit, getCachedAccount } from "./cache";
import type { Account } from "./ctl";
import { lookupAccount } from "./ctl";

export type AccountLookup =
  | { status: "ok"; account: Account }
  | { status: "rate_limited" }
  | { status: "not_provisioned" }
  | { status: "unavailable" };

export async function getAccount(env: Env, uid: string): Promise<AccountLookup> {
  if (!(await checkRateLimit(env.KEYS_CACHE, uid, "keys"))) {
    return { status: "rate_limited" };
  }
  const cached = await getCachedAccount(env.KEYS_CACHE, uid);
  if (cached) return { status: "ok", account: cached };
  return fetchAndCache(env, uid);
}

async function fetchAndCache(env: Env, uid: string): Promise<AccountLookup> {
  try {
    const account = await lookupAccount(env.CTL_DB_URL, env.CTL_DB_TOKEN, uid);
    if (!account) return { status: "not_provisioned" };
    await cacheAccount(env.KEYS_CACHE, uid, account);
    return { status: "ok", account };
  } catch {
    return { status: "unavailable" };
  }
}
