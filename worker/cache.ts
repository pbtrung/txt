// docs/auth.md §6: one KV cache key per uid holding exactly what /v1/keys
// returns, including the inputs used to issue an R2 binding ticket. Only
// /v1/keys uses this cache; /v1/r2-token verifies the ticket without ctl.
// The 24-hour TTL bounds how long a deprovisioned user keeps being served.
//
// Rate-limiting is per uid and endpoint and applies before cache lookup, so a
// warm account cache cannot bypass it. Separate budgets keep routine R2 token
// renewal from locking a user out of /v1/keys.

import type { Account } from "./ctl";

const KEYS_TTL_SECONDS = 24 * 60 * 60;
const ACCOUNT_CACHE_VERSION = 3;
const RATE_LIMIT_VERSION = 3;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX_REQUESTS = {
  keys: 60,
  "r2-token": 30,
} as const;

export type RateLimitScope = keyof typeof RATE_LIMIT_MAX_REQUESTS;

export async function getCachedAccount(
  kv: KVNamespace,
  uid: string,
): Promise<Account | null> {
  const value = await kv.get(accountCacheKey(uid));
  return value ? (JSON.parse(value) as Account) : null;
}

export async function cacheAccount(
  kv: KVNamespace,
  uid: string,
  account: Account,
): Promise<void> {
  await kv.put(accountCacheKey(uid), JSON.stringify(account), {
    expirationTtl: KEYS_TTL_SECONDS,
  });
}

export async function purgeAccount(kv: KVNamespace, uid: string): Promise<void> {
  await Promise.all([
    kv.delete(accountCacheKey(uid)),
    kv.delete(`keys:v2:${uid}`),
    kv.delete(`keys:${uid}`),
  ]);
}

function accountCacheKey(uid: string): string {
  return `keys:v${ACCOUNT_CACHE_VERSION}:${uid}`;
}

export async function checkRateLimit(
  kv: KVNamespace,
  uid: string,
  scope: RateLimitScope,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `ratelimit:v${RATE_LIMIT_VERSION}:${scope}:${uid}:${windowStart}`;
  const count = Number((await kv.get(key)) ?? "0");
  if (count >= RATE_LIMIT_MAX_REQUESTS[scope]) return false;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}
