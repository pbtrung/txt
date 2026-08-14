// docs/auth.md §4/§5: POST /v1/db-token. Verifies the caller's Firebase ID
// token, looks them up in ctl, and mints a Turso database token scoped to
// their own database -- through the KV cache and rate limit §6 describes.

import { cacheAccount, cacheToken, checkRateLimit, getCachedAccount, getCachedToken } from "./cache";
import { verifiedUid } from "./auth";
import { lookupUser, type Account } from "./ctl";
import { DatabaseNotFoundError, mintDbToken } from "./turso";

export async function handleDbToken(request: Request, env: Env): Promise<Response> {
  const uid = await verifiedUid(request, env.FIREBASE_PROJECT_ID);
  if (uid === null) return new Response("missing or invalid bearer token", { status: 401 });
  return respondForUid(uid, env);
}

async function respondForUid(uid: string, env: Env): Promise<Response> {
  const cached = await getCachedToken(env.DB_TOKEN_CACHE, uid);
  if (cached) return Response.json({ db_token: cached.dbToken, db_url: cached.dbUrl });
  if (!(await checkRateLimit(env.DB_TOKEN_CACHE, uid))) {
    return new Response("rate limit exceeded", { status: 429 });
  }
  return mintFreshForUid(uid, env);
}

async function mintFreshForUid(uid: string, env: Env): Promise<Response> {
  try {
    return await mintForUid(uid, env);
  } catch (err) {
    const detail = err instanceof DatabaseNotFoundError ? "database not provisioned yet" : "ctl or Turso Platform API unavailable";
    return new Response(detail, { status: 503 });
  }
}

async function mintForUid(uid: string, env: Env): Promise<Response> {
  const account = await resolveAccount(uid, env);
  if (!account) return new Response("not provisioned", { status: 403 });
  const dbToken = await mintDbToken(env.TURSO_ORG_TOKEN, env.TURSO_ORG, account.dbPath);
  const dbUrl = `libsql://${account.dbPath}-${env.TURSO_ORG}.aws-us-east-1.turso.io`;
  await cacheToken(env.DB_TOKEN_CACHE, uid, { dbToken, dbUrl });
  return Response.json({ db_token: dbToken, db_url: dbUrl });
}

async function resolveAccount(uid: string, env: Env): Promise<Account | null> {
  const cached = await getCachedAccount(env.DB_TOKEN_CACHE, uid);
  if (cached) return cached;
  const account = await lookupUser(env.CTL_DB_URL, env.CTL_DB_TOKEN, uid);
  if (account) await cacheAccount(env.DB_TOKEN_CACHE, uid, account);
  return account;
}
