// docs/auth.md §6: one KV cache key per uid holding exactly what /v1/keys
// returns (type/umk/cred_store content) and what /v1/r2-token needs
// (type) -- both endpoints share it, so a cache hit for either skips the
// ctl round trip entirely. The 24-hour TTL bounds how long a deprovisioned
// user keeps being served; revocation (§7) purges this key explicitly.
//
// Rate-limiting is per uid on both endpoints, gating only the ctl work a
// cache miss triggers -- a cache hit never touches this counter, since it
// never touches the resource the limit protects. No specific number is
// mandated in docs/auth.md §6, so this is a judgment call.

import type { Account } from "./ctl";

const KEYS_TTL_SECONDS = 24 * 60 * 60;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX_REQUESTS = 20;

export async function getCachedAccount(
  kv: KVNamespace,
  uid: string,
): Promise<Account | null> {
  const value = await kv.get(`keys:${uid}`);
  return value ? (JSON.parse(value) as Account) : null;
}

export async function cacheAccount(
  kv: KVNamespace,
  uid: string,
  account: Account,
): Promise<void> {
  await kv.put(`keys:${uid}`, JSON.stringify(account), {
    expirationTtl: KEYS_TTL_SECONDS,
  });
}

export async function purgeAccount(kv: KVNamespace, uid: string): Promise<void> {
  await kv.delete(`keys:${uid}`);
}

export async function checkRateLimit(kv: KVNamespace, uid: string): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `ratelimit:${uid}:${windowStart}`;
  const count = Number((await kv.get(key)) ?? "0");
  if (count >= RATE_LIMIT_MAX_REQUESTS) return false;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}
