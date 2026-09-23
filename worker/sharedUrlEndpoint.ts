// docs/sharing.md §3.3: POST /v1/shared-url -- the one public endpoint,
// capability possession is the entire authorization. Mints a single,
// object-scoped, 60-second R2 credential via the same local JWT-signing
// mechanism worker/r2CredentialsEndpoint.ts uses (no network call), then
// presigns a GET locally with it (aws4fetch, no extra round trip) --
// reusing that mechanism here avoids ever deriving or storing a
// standalone S3-style secret key for the parent R2 token.
import { AwsClient } from "aws4fetch";
import { openGrant } from "./shareGrant";
import { createMintCredential } from "./r2CredentialsEndpoint";
import { base64Decode, base64Encode, base64UrlDecode, sha256 } from "./base64";
import { requireVar } from "./requireVar";
import { SHARE_ID_LEN } from "./shareValidation";

const PRESIGN_TTL_SECONDS = 60;
// docs/sharing.md §2: a grant is at most 512 bytes. Every length is checked
// before any decoding or decryption work, since this endpoint is reachable
// by anyone -- an oversized body is rejected while it is still streaming.
const MAX_GRANT_LEN = 512;
const MAX_GRANT_B64_LEN = Math.ceil((MAX_GRANT_LEN * 4) / 3);
const SHARE_ID_B64_LEN = Math.ceil((SHARE_ID_LEN * 4) / 3);
const MAX_BODY_BYTES = 1024;

class RedemptionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RedemptionError";
  }
}

interface Redemption {
  shareId: Uint8Array;
  grantBytes: Uint8Array;
}

// Stops reading as soon as the body exceeds `maxBytes`, rather than trusting
// Content-Length (absent on a chunked body) or buffering it all first.
async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > maxBytes) throw new RedemptionError(413, "request body too large");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request.body ?? []) {
    total += chunk.length;
    if (total > maxBytes) throw new RedemptionError(413, "request body too large");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  chunks.reduce(
    (offset, chunk) => (bytes.set(chunk, offset), offset + chunk.length),
    0,
  );
  return new TextDecoder().decode(bytes);
}

function parseJsonObject(text: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RedemptionError(400, "malformed request body");
  }
  if (typeof body !== "object" || body === null) {
    throw new RedemptionError(400, "malformed request body");
  }
  return body as Record<string, unknown>;
}

function decodeRedemption(shareIdB64: string, grantB64: string): Redemption {
  if (shareIdB64.length !== SHARE_ID_B64_LEN || grantB64.length > MAX_GRANT_B64_LEN) {
    throw new RedemptionError(400, "malformed capability or grant");
  }
  let redemption: Redemption;
  try {
    redemption = {
      shareId: base64UrlDecode(shareIdB64),
      grantBytes: base64UrlDecode(grantB64),
    };
  } catch {
    throw new RedemptionError(400, "malformed capability or grant");
  }
  const { shareId, grantBytes } = redemption;
  if (shareId.length !== SHARE_ID_LEN || grantBytes.length > MAX_GRANT_LEN) {
    throw new RedemptionError(400, "malformed capability or grant");
  }
  return redemption;
}

async function parseRedemption(request: Request): Promise<Redemption> {
  const body = parseJsonObject(await readBoundedBody(request, MAX_BODY_BYTES));
  const { share_id: shareIdB64, grant: grantB64 } = body;
  if (typeof shareIdB64 !== "string" || typeof grantB64 !== "string") {
    throw new RedemptionError(400, "missing share_id or grant");
  }
  return decodeRedemption(shareIdB64, grantB64);
}

// Uniform failure: an invalid grant, an unknown share_id_hash, and a
// non-active/stale row must all look identical to the caller
// (docs/sharing.md §3.3) -- only a grant that fails to open at all is 400.
async function resolveObjectPath(env: Env, redemption: Redemption): Promise<string> {
  const shareIdHash = await sha256(redemption.shareId);
  let objectPath: string;
  try {
    objectPath = await openGrant(
      redemption.grantBytes,
      shareIdHash,
      base64Decode(env.SHARE_GRANT_KEY),
    );
  } catch {
    throw new RedemptionError(400, "malformed capability or grant");
  }
  await requireActiveShare(env, shareIdHash, objectPath);
  return objectPath;
}

async function requireActiveShare(
  env: Env,
  shareIdHash: Uint8Array,
  objectPath: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT object_path_hash FROM shares WHERE share_id_hash = ? AND state = 'active'",
  )
    .bind(shareIdHash)
    .first<{ object_path_hash: ArrayBuffer }>();
  const objectPathHash = await sha256(new TextEncoder().encode(objectPath));
  if (!row || base64Encode(row.object_path_hash) !== base64Encode(objectPathHash)) {
    throw new RedemptionError(404, "no active share for this capability");
  }
}

async function mintObjectCredential(env: Env, objectPath: string) {
  try {
    return await createMintCredential(env)(
      "object-read-only",
      { objects: [objectPath] },
      PRESIGN_TTL_SECONDS,
    );
  } catch {
    // Local signing has no network dependency left to fail -- this is
    // always a configuration problem, hence a plain 500 rather than an
    // upstream-outage status (worker/r2CredentialsEndpoint.ts).
    throw new RedemptionError(500, "failed to mint R2 credential");
  }
}

async function presignObjectGet(env: Env, objectPath: string): Promise<string> {
  const credential = await mintObjectCredential(env, objectPath);
  const accountId = requireVar(env.CF_ACCOUNT_ID, "CF_ACCOUNT_ID");
  const bucket = requireVar(env.BUCKET_NAME, "BUCKET_NAME");
  const aws = new AwsClient({
    accessKeyId: credential.access_key_id,
    secretAccessKey: credential.secret_access_key,
    sessionToken: credential.session_token,
    service: "s3",
    region: "auto",
  });
  const url = new URL(
    `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${objectPath}`,
  );
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  const signed = await aws.sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}

export async function handlePostSharedUrl(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const objectPath = await resolveObjectPath(env, await parseRedemption(request));
    return Response.json(
      {
        url: await presignObjectGet(env, objectPath),
        expires_at: Math.floor(Date.now() / 1000) + PRESIGN_TTL_SECONDS,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (!(error instanceof RedemptionError)) throw error;
    return new Response(error.message, { status: error.status });
  }
}
