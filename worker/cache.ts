// docs/auth.md §6: KV caching (token:{uid} 55m, user:{uid} 24h) so steady
// state is one KV read, and a per-uid rate limit gating the ctl/Platform
// API work a cache miss triggers -- 10 requests/hour is generous for a
// client that refreshes hourly, bounds how hard a looping client can hit
// the organization's Platform API quota, and (checked on the same path a
// 403 takes, per docs/auth.md's own "rate-limit 403s per uid too") stops
// an unprovisioned client retrying in a loop from hitting ctl every time.
// Cache hits never touch this counter at all, since they touch neither
// resource it protects.

const TOKEN_TTL_SECONDS = 55 * 60;
const USER_TTL_SECONDS = 24 * 60 * 60;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX_REQUESTS = 10;

export interface CachedToken {
  dbToken: string;
  dbUrl: string;
}

export async function getCachedToken(kv: KVNamespace, uid: string): Promise<CachedToken | null> {
  const value = await kv.get(`token:${uid}`);
  return value ? (JSON.parse(value) as CachedToken) : null;
}

export async function cacheToken(kv: KVNamespace, uid: string, token: CachedToken): Promise<void> {
  await kv.put(`token:${uid}`, JSON.stringify(token), { expirationTtl: TOKEN_TTL_SECONDS });
}

export async function getCachedDbPath(kv: KVNamespace, uid: string): Promise<string | null> {
  return kv.get(`user:${uid}`);
}

export async function cacheDbPath(kv: KVNamespace, uid: string, dbPath: string): Promise<void> {
  await kv.put(`user:${uid}`, dbPath, { expirationTtl: USER_TTL_SECONDS });
}

export async function checkRateLimit(kv: KVNamespace, uid: string): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `ratelimit:${uid}:${windowStart}`;
  const count = Number((await kv.get(key)) ?? "0");
  if (count >= RATE_LIMIT_MAX_REQUESTS) return false;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}
