// Mints a short-lived R2 (S3-compatible) temporary credential via
// Cloudflare's own local-signing scheme: a JWT HMAC-signed with the
// account's parent R2 secret, no outbound Cloudflare API call needed. R2
// derives the same values server-side from the accessKeyId (which parent
// secret to re-verify the signature against) on every signed request that
// carries them.
//
// Both the admin's bucket-wide read-write credential and an ordinary
// user's scoped read-only credential (docs/auth.md §4.2) are signed from
// the same parent pair (R2_READ_WRITE_*) -- scoping lives entirely in what
// gets signed into the JWT, not in which parent key signs it. An ordinary
// user's credential is scoped to both the single object at db_path and
// everything under db_prefix, since the two need their own authorization
// (docs/auth.md §4.2). The Worker cannot verify that a caller's
// db_path/db_prefix are really its own -- see docs/auth.md §8.

import { base64url, SignJWT } from "jose";
import type { AccountLookup } from "./account";
import { getAccount } from "./account";
import type { Account } from "./ctl";
import { verifiedUid } from "./auth";

const TTL_SECONDS = 900;

interface R2Credential {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expiration: string;
  endpoint: string;
  bucket: string;
  region: string;
}

interface Paths {
  objectPaths: string[];
  prefixPaths: string[];
}

export async function handleR2Token(request: Request, env: Env): Promise<Response> {
  const uid = await verifiedUid(request, env.FIREBASE_PROJECT_ID);
  if (uid === null)
    return new Response("missing or invalid bearer token", { status: 401 });
  const result = await getAccount(env, uid);
  if (result.status !== "ok") return statusResponse(result);
  return mintForAccount(request, env, result.account);
}

function statusResponse(result: Exclude<AccountLookup, { status: "ok" }>): Response {
  if (result.status === "rate_limited")
    return new Response("rate limit exceeded", { status: 429 });
  if (result.status === "not_provisioned")
    return new Response("not provisioned", { status: 403 });
  return new Response("ctl unavailable", { status: 503 });
}

async function mintForAccount(
  request: Request,
  env: Env,
  account: Account,
): Promise<Response> {
  if (account.type === "admin") {
    return Response.json(await mintCredential(env, "object-read-write", null));
  }
  const paths = await readPaths(request);
  if (!paths)
    return new Response("db_path and db_prefix are required", { status: 400 });
  try {
    return Response.json(await mintCredential(env, "object-read-only", paths));
  } catch {
    return new Response("R2 signing unavailable", { status: 503 });
  }
}

async function readPaths(request: Request): Promise<Paths | null> {
  try {
    const body = (await request.json()) as { db_path?: unknown; db_prefix?: unknown };
    if (typeof body.db_path !== "string" || !body.db_path) return null;
    if (typeof body.db_prefix !== "string" || !body.db_prefix) return null;
    return { objectPaths: [body.db_path], prefixPaths: [`${body.db_prefix}/`] };
  } catch {
    return null;
  }
}

async function mintCredential(
  env: Env,
  scope: string,
  paths: Paths | null,
): Promise<R2Credential> {
  const endpointUrl = new URL(env.R2_ENDPOINT);
  const accountId = endpointUrl.hostname.split(".")[0];
  const claims: Record<string, unknown> = { bucket: env.R2_BUCKET, scope };
  if (paths) claims.paths = paths;
  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(accountId)
    .setIssuer(env.R2_READ_WRITE_ACCESS_KEY_ID)
    .setAudience(endpointUrl.host)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(env.R2_READ_WRITE_SECRET_ACCESS_KEY));
  return {
    access_key_id: env.R2_READ_WRITE_ACCESS_KEY_ID,
    secret_access_key: await sha256Hex(jwt),
    // Must be base64url, not plain base64: R2 rejects standard btoa() output
    // (+/'s and '=' padding) with InvalidArgument on X-Amz-Security-Token.
    session_token: base64url.encode(`jwt/${jwt}`),
    expiration: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
    // The client carries no R2 connection details of its own -- this
    // response is its only source of them (docs/auth.md §4.2).
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    region: env.R2_REGION,
  };
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
