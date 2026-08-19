import { jwtVerify, SignJWT } from "jose";

import { isStoragePath, storagePathBinding } from "../shared/r2Proof";
import { getAccount } from "./account";
import { verifiedUid } from "./auth";
import { decodeBase64, encodeBase64, equalBytes } from "./base64";
import { mintCredential } from "./r2Token";

const AUDIENCE = "shared-r2-token";
const VERSION = 1;
const SHARE_ID_BYTES = 32;
const MAX_GRANT_LENGTH = 4096;

export async function handleCreateShareGrant(
  request: Request,
  env: Env,
): Promise<Response> {
  const uid = await verifiedUid(request, env.FIREBASE_PROJECT_ID);
  if (uid === null) return new Response("invalid bearer token", { status: 401 });
  if (uid !== env.ADMIN_UID) return new Response("administrator only", { status: 403 });
  const body = await readBody(request);
  if (!body) return new Response("malformed share", { status: 400 });
  const lookup = await getAccount(env, uid);
  if (lookup.status !== "ok") return accountFailure(lookup.status);
  const binding = await storagePathBinding(body.dbPath, body.dbPrefix);
  if (!equalBytes(binding, decodeBase64(lookup.account.dbBindingHash))) {
    return new Response("path not authorized", { status: 403 });
  }
  const objectPath = shareObjectPath(body);
  const grant = await signGrant(env, uid, body.shareId, objectPath);
  return Response.json({ grant });
}

export async function handleSharedR2Token(
  request: Request,
  env: Env,
): Promise<Response> {
  const grant = await readGrant(request);
  if (!grant) return new Response("malformed grant", { status: 400 });
  const objectPath = await verifyGrant(grant, env.R2_TICKET_SECRET, env.ADMIN_UID);
  if (!objectPath) return new Response("invalid grant", { status: 401 });
  try {
    const credential = await mintCredential(env, "shared", "object-read-only", {
      objectPaths: [objectPath],
      prefixPaths: [],
    });
    return Response.json({
      credential,
      object_path: objectPath,
      endpoint: env.R2_ENDPOINT,
      bucket: env.R2_BUCKET,
      region: env.R2_REGION,
    });
  } catch {
    return new Response("R2 signing unavailable", { status: 503 });
  }
}

interface ShareBody {
  dbPath: string;
  dbPrefix: string;
  sharePrefix: string;
  sharePath: string;
  shareId: string;
}

async function readBody(request: Request): Promise<ShareBody | null> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const values = [body.db_path, body.db_prefix, body.share_prefix, body.share_path];
    if (!values.every((value) => typeof value === "string" && isStoragePath(value))) {
      return null;
    }
    if (typeof body.share_id !== "string" || !validShareId(body.share_id)) return null;
    return {
      dbPath: body.db_path as string,
      dbPrefix: body.db_prefix as string,
      sharePrefix: body.share_prefix as string,
      sharePath: body.share_path as string,
      shareId: body.share_id,
    };
  } catch {
    return null;
  }
}

function validShareId(value: string): boolean {
  const bytes = decodeBase64(value);
  return bytes.byteLength === SHARE_ID_BYTES && encodeBase64(bytes) === value;
}

function shareObjectPath(body: ShareBody): string {
  return `${body.dbPrefix}/shared/${body.sharePrefix}/${body.sharePath}`;
}

function signGrant(
  env: Env,
  uid: string,
  shareId: string,
  objectPath: string,
): Promise<string> {
  return new SignJWT({ v: VERSION, object_path: objectPath })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setAudience(AUDIENCE)
    .setSubject(uid)
    .setJti(shareId)
    .setIssuedAt()
    .sign(decodeBase64(env.R2_TICKET_SECRET));
}

async function readGrant(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return typeof body.grant === "string" && body.grant.length <= MAX_GRANT_LENGTH
      ? body.grant
      : null;
  } catch {
    return null;
  }
}

async function verifyGrant(
  grant: string,
  secret: string,
  adminUid: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(grant, decodeBase64(secret), {
      algorithms: ["HS256"],
      audience: AUDIENCE,
    });
    if (payload.v !== VERSION || payload.sub !== adminUid) return null;
    if (typeof payload.jti !== "string" || !validShareId(payload.jti)) return null;
    return validSharedObjectPath(payload.object_path) ? payload.object_path : null;
  } catch {
    return null;
  }
}

function validSharedObjectPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return (
    parts.length === 4 &&
    isStoragePath(parts[0]) &&
    parts[1] === "shared" &&
    isStoragePath(parts[2]) &&
    isStoragePath(parts[3])
  );
}

function accountFailure(status: string): Response {
  if (status === "rate_limited")
    return new Response("rate limit exceeded", { status: 429 });
  if (status === "not_provisioned")
    return new Response("not provisioned", { status: 403 });
  return new Response("ctl unavailable", { status: 503 });
}
