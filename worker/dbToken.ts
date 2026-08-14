// docs/auth.md §4/§5: POST /v1/db-token. Verifies the caller's Firebase ID
// token, looks them up in ctl, and mints a Turso database token scoped to
// their own database -- through the KV cache and rate limit §6 describes.

import { cacheDbPath, cacheToken, checkRateLimit, getCachedDbPath, getCachedToken } from "./cache";
import { lookupUser } from "./ctl";
import { verifyFirebaseIdToken } from "./firebaseAuth";
import { DatabaseNotFoundError, mintDbToken } from "./turso";

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

async function tryVerify(idToken: string, projectId: string): Promise<string | null> {
  try {
    return (await verifyFirebaseIdToken(idToken, projectId)).uid;
  } catch {
    return null;
  }
}

export async function handleDbToken(request: Request, env: Env): Promise<Response> {
  const idToken = bearerToken(request);
  if (!idToken) return new Response("missing bearer token", { status: 401 });
  const uid = await tryVerify(idToken, env.FIREBASE_PROJECT_ID);
  if (uid === null) return new Response("invalid id token", { status: 401 });
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
  const dbPath = await resolveDbPath(uid, env);
  if (!dbPath) return new Response("not provisioned", { status: 403 });
  const dbToken = await mintDbToken(env.TURSO_ORG_TOKEN, env.TURSO_ORG, dbPath);
  const dbUrl = `libsql://${dbPath}-${env.TURSO_ORG}.aws-us-east-1.turso.io`;
  await cacheToken(env.DB_TOKEN_CACHE, uid, { dbToken, dbUrl });
  return Response.json({ db_token: dbToken, db_url: dbUrl });
}

async function resolveDbPath(uid: string, env: Env): Promise<string | null> {
  const cached = await getCachedDbPath(env.DB_TOKEN_CACHE, uid);
  if (cached) return cached;
  const dbPath = await lookupUser(env.CTL_DB_URL, env.CTL_DB_TOKEN, uid);
  if (dbPath) await cacheDbPath(env.DB_TOKEN_CACHE, uid, dbPath);
  return dbPath;
}
