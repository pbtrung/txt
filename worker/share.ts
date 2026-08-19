import { AwsClient } from "aws4fetch";
import { base64url } from "jose";

import { isStoragePath, storagePathBinding } from "../shared/r2Proof";
import { getAccount } from "./account";
import { verifiedUid } from "./auth";
import { decodeBase64, encodeBase64, equalBytes } from "./base64";

const GRANT_VERSION = 1;
const SHARE_ID_BYTES = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const GRANT_DOMAIN = new TextEncoder().encode("txt:share-grant:v1");
const GRANT_KEY_DOMAIN = new TextEncoder().encode("txt:share-grant-key:v1");

interface ShareBody {
  dbPath: string;
  dbPrefix: string;
  sharePrefix: string;
  sharePath: string;
  shareId: Uint8Array;
}

interface RegistryRow {
  object_path_hash: ArrayBuffer;
  state: "active" | "deleted";
}

export async function handleCreateShareGrant(
  request: Request,
  env: Env,
): Promise<Response> {
  const uid = await verifiedAdmin(request, env);
  if (uid instanceof Response) return uid;
  const body = await readShareBody(request);
  if (!body) return new Response("malformed share", { status: 400 });
  const account = await getAccount(env, uid);
  if (account.status !== "ok") return accountFailure(account.status);
  if (!(await pathsMatch(account.account.dbBindingHash, body))) {
    return new Response("path not authorized", { status: 403 });
  }
  const objectPath = shareObjectPath(body);
  const registered = await registerShare(env, body.shareId, objectPath);
  if (registered instanceof Response) return registered;
  return Response.json({ grant: await encryptGrant(env, body.shareId, objectPath) });
}

export async function handleDeleteShare(request: Request, env: Env): Promise<Response> {
  const uid = await verifiedAdmin(request, env);
  if (uid instanceof Response) return uid;
  const shareId = await readShareId(request);
  if (!shareId) return new Response("malformed share id", { status: 400 });
  await env.SHARE_REGISTRY.prepare(
    "UPDATE share_registry SET state = 'deleted', deleted_at = ? " +
      "WHERE share_id_hash = ? AND state = 'active'",
  )
    .bind(Date.now(), await sha256(shareId))
    .run();
  return new Response(null, { status: 204 });
}

export async function handleSharedContent(
  request: Request,
  env: Env,
): Promise<Response> {
  const input = await readContentRequest(request);
  if (!input) return new Response("malformed share", { status: 400 });
  const idHash = await sha256(input.shareId);
  const row = await registryRow(env, idHash);
  if (!row || row.state !== "active")
    return new Response("share not found", { status: 404 });
  const objectPath = await decryptGrant(env, input.shareId, input.grant);
  if (!objectPath) return new Response("invalid share grant", { status: 401 });
  if (!equalBytes(new Uint8Array(row.object_path_hash), await sha256Text(objectPath))) {
    return new Response("share path mismatch", { status: 401 });
  }
  return fetchEncryptedObject(env, objectPath);
}

async function verifiedAdmin(request: Request, env: Env): Promise<string | Response> {
  const uid = await verifiedUid(request, env.FIREBASE_PROJECT_ID);
  if (uid === null) return new Response("invalid bearer token", { status: 401 });
  return uid === env.ADMIN_UID
    ? uid
    : new Response("administrator only", { status: 403 });
}

async function pathsMatch(binding: string, body: ShareBody): Promise<boolean> {
  return equalBytes(
    await storagePathBinding(body.dbPath, body.dbPrefix),
    decodeBase64(binding),
  );
}

async function registerShare(
  env: Env,
  shareId: Uint8Array,
  objectPath: string,
): Promise<true | Response> {
  const idHash = await sha256(shareId);
  const pathHash = await sha256Text(objectPath);
  await env.SHARE_REGISTRY.prepare(
    "INSERT OR IGNORE INTO share_registry " +
      "(share_id_hash, object_path_hash, state, created_at) " +
      "VALUES (?, ?, 'active', ?)",
  )
    .bind(idHash, pathHash, Date.now())
    .run();
  const row = await registryRow(env, idHash);
  if (!row || row.state !== "active") {
    return new Response("share was deleted", { status: 409 });
  }
  return equalBytes(new Uint8Array(row.object_path_hash), pathHash)
    ? true
    : new Response("share id already registered", { status: 409 });
}

function registryRow(env: Env, idHash: Uint8Array): Promise<RegistryRow | null> {
  return env.SHARE_REGISTRY.prepare(
    "SELECT object_path_hash, state FROM share_registry WHERE share_id_hash = ?",
  )
    .bind(idHash)
    .first<RegistryRow>();
}

async function encryptGrant(
  env: Env,
  shareId: Uint8Array,
  objectPath: string,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: await grantAad(shareId) },
      await grantKey(env.SHARE_GRANT_KEY, salt, shareId),
      new TextEncoder().encode(objectPath),
    ),
  );
  return base64url.encode(
    concat(new Uint8Array([GRANT_VERSION]), salt, nonce, ciphertext),
  );
}

async function decryptGrant(
  env: Env,
  shareId: Uint8Array,
  grant: Uint8Array,
): Promise<string | null> {
  const nonceOffset = 1 + SALT_BYTES;
  const ciphertextOffset = nonceOffset + NONCE_BYTES;
  if (grant[0] !== GRANT_VERSION || grant.byteLength <= ciphertextOffset + 16)
    return null;
  try {
    const salt = grant.slice(1, nonceOffset);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: grant.slice(nonceOffset, ciphertextOffset),
        additionalData: await grantAad(shareId),
      },
      await grantKey(env.SHARE_GRANT_KEY, salt, shareId),
      grant.slice(ciphertextOffset),
    );
    const path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      plaintext,
    );
    return validSharedObjectPath(path) ? path : null;
  } catch {
    return null;
  }
}

async function grantKey(
  value: string,
  salt: Uint8Array,
  shareId: Uint8Array,
): Promise<CryptoKey> {
  const raw = decodeBase64(value);
  if (raw.byteLength !== 32 || encodeBase64(raw) !== value) {
    throw new Error("SHARE_GRANT_KEY must be exactly 32 bytes in standard base64");
  }
  const master = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: concat(GRANT_KEY_DOMAIN, await sha256(shareId)),
    },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function grantAad(shareId: Uint8Array): Promise<Uint8Array> {
  return concat(GRANT_DOMAIN, await sha256(shareId));
}

async function fetchEncryptedObject(env: Env, objectPath: string): Promise<Response> {
  const aws = new AwsClient({
    accessKeyId: env.R2_READ_WRITE_ACCESS_KEY_ID,
    secretAccessKey: env.R2_READ_WRITE_SECRET_ACCESS_KEY,
    region: env.R2_REGION,
    service: "s3",
  });
  const base = `${env.R2_ENDPOINT.replace(/\/$/, "")}/${env.R2_BUCKET}`;
  const response = await aws.fetch(`${base}/${objectPath}`, { cache: "no-store" });
  if (response.status === 404) return new Response("share not found", { status: 404 });
  if (!response.ok) return new Response("shared content unavailable", { status: 503 });
  return new Response(response.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}

async function readShareBody(request: Request): Promise<ShareBody | null> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const paths = [body.db_path, body.db_prefix, body.share_prefix, body.share_path];
    if (!paths.every((value) => typeof value === "string" && isStoragePath(value)))
      return null;
    const shareId = parseStandardShareId(body.share_id);
    if (!shareId) return null;
    return {
      dbPath: body.db_path as string,
      dbPrefix: body.db_prefix as string,
      sharePrefix: body.share_prefix as string,
      sharePath: body.share_path as string,
      shareId,
    };
  } catch {
    return null;
  }
}

async function readShareId(request: Request): Promise<Uint8Array | null> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return parseStandardShareId(body.share_id);
  } catch {
    return null;
  }
}

async function readContentRequest(
  request: Request,
): Promise<{ shareId: Uint8Array; grant: Uint8Array } | null> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.share_id !== "string" || typeof body.grant !== "string")
      return null;
    const shareId = base64url.decode(body.share_id);
    const grant = base64url.decode(body.grant);
    return shareId.byteLength === SHARE_ID_BYTES ? { shareId, grant } : null;
  } catch {
    return null;
  }
}

function parseStandardShareId(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const bytes = decodeBase64(value);
  return bytes.byteLength === SHARE_ID_BYTES && encodeBase64(bytes) === value
    ? bytes
    : null;
}

function shareObjectPath(body: ShareBody): string {
  return `${body.dbPrefix}/shared/${body.sharePrefix}/${body.sharePath}`;
}

function validSharedObjectPath(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.length === 4 &&
    isStoragePath(parts[0]) &&
    parts[1] === "shared" &&
    isStoragePath(parts[2]) &&
    isStoragePath(parts[3])
  );
}

function sha256(value: Uint8Array): Promise<Uint8Array> {
  return crypto.subtle.digest("SHA-256", value).then((hash) => new Uint8Array(hash));
}

function sha256Text(value: string): Promise<Uint8Array> {
  return sha256(new TextEncoder().encode(value));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function accountFailure(status: string): Response {
  if (status === "rate_limited")
    return new Response("rate limit exceeded", { status: 429 });
  if (status === "not_provisioned")
    return new Response("not provisioned", { status: 403 });
  return new Response("ctl unavailable", { status: 503 });
}
