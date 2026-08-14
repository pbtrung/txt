// Mints a short-lived R2 (S3-compatible) temporary credential via
// Cloudflare's own local-signing scheme: a JWT HMAC-signed with the
// account's parent R2 secret, no outbound Cloudflare API call needed. R2
// derives the same values server-side from the accessKeyId (which parent
// secret to re-verify the signature against) on every signed request that
// carries them.
//
// Scoped by account type (ctl.ts's Account.type): the admin gets
// bucket-wide read-write, matching the org-wide Turso credential it already
// holds; an ordinary user gets read-only restricted to their own
// client-supplied db_prefix. The Worker cannot verify that a user's
// db_prefix is really theirs -- it never unwraps umk -- but trusting it
// here is not a real escalation: read access to someone else's ciphertext
// under this system's threat model is not meaningfully different from the
// bucket-wide read access this replaces (docs/data_model.md §2:
// confidentiality rests entirely on encryption, not on who can list/read
// raw bytes).
import { base64url, SignJWT } from "jose";
import { verifiedUid } from "./auth";
import { cacheAccount, getCachedAccount } from "./cache";
import { lookupUser, type Account } from "./ctl";

// Comfortably covers one reading session's worth of R2 GETs; the client
// renews shortly before expiry rather than this being cached/reused past
// that point (local JWT signing is cheap -- no Platform API quota at stake
// the way db-token minting has, so there's no need to cache the credential
// itself the way §6 caches the Turso token).
const TTL_SECONDS = 900;

interface R2Credential {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expires_at_ms: number;
}

export async function handleR2Token(request: Request, env: Env): Promise<Response> {
  const uid = await verifiedUid(request, env.FIREBASE_PROJECT_ID);
  if (uid === null) return new Response("missing or invalid bearer token", { status: 401 });
  const account = await resolveAccount(uid, env);
  if (!account) return new Response("not provisioned", { status: 403 });
  return mintForAccount(request, env, account);
}

async function resolveAccount(uid: string, env: Env): Promise<Account | null> {
  const cached = await getCachedAccount(env.DB_TOKEN_CACHE, uid);
  if (cached) return cached;
  const account = await lookupUser(env.CTL_DB_URL, env.CTL_DB_TOKEN, uid);
  if (account) await cacheAccount(env.DB_TOKEN_CACHE, uid, account);
  return account;
}

async function mintForAccount(request: Request, env: Env, account: Account): Promise<Response> {
  if (account.type === "admin") return Response.json(await mintCredential(env, "object-read-write", null));
  const dbPrefix = await readDbPrefix(request);
  if (!dbPrefix) return new Response("db_prefix is required for a non-admin account", { status: 400 });
  return Response.json(await mintCredential(env, "object-read-only", `${dbPrefix}/`));
}

async function readDbPrefix(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { db_prefix?: unknown };
    return typeof body.db_prefix === "string" && body.db_prefix.length > 0 ? body.db_prefix : null;
  } catch {
    return null;
  }
}

async function mintCredential(env: Env, scope: string, prefix: string | null): Promise<R2Credential> {
  const endpointUrl = new URL(env.R2_ENDPOINT);
  const accountId = endpointUrl.hostname.split(".")[0];
  const claims: Record<string, unknown> = { bucket: env.R2_BUCKET, scope };
  if (prefix) claims.paths = { prefixPaths: [prefix] };
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
    // (+/'s and '=' padding) with InvalidArgument on X-Amz-Security-Token --
    // confirmed empirically in this project's own history (a real prior
    // Worker's r2Creds.ts, since deleted) before a later rewrite of that
    // file silently regressed back to plain base64. jose's own base64url
    // encoder is reused here rather than hand-rolling it again.
    session_token: base64url.encode(`jwt/${jwt}`),
    expires_at_ms: Date.now() + TTL_SECONDS * 1000,
  };
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
