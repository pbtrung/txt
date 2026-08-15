// Shared by keys.ts and r2Token.ts: resolve a uid to its ctl account,
// through the cache and rate limit docs/auth.md §6 describes, in the one
// order that matters -- a cache hit skips the rate limiter entirely, since
// it never touches the ctl round trip the limiter protects.

import { cacheAccount, checkRateLimit, getCachedAccount } from "./cache";
import type { Account } from "./ctl";
import { lookupAccount } from "./ctl";

export type AccountLookup =
  | { status: "ok"; account: Account }
  | { status: "rate_limited" }
  | { status: "not_provisioned" }
  | { status: "unavailable" };

export async function getAccount(env: Env, uid: string): Promise<AccountLookup> {
  const cached = await getCachedAccount(env.KEYS_CACHE, uid);
  if (cached) return { status: "ok", account: cached };
  if (!(await checkRateLimit(env.KEYS_CACHE, uid))) return { status: "rate_limited" };
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
