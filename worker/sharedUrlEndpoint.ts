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
import { base64Encode, base64UrlDecode } from "./base64";
import { decodeBase64Secret } from "./ownerEndpoint";
import { requireVar } from "./requireVar";
import { SHARE_ID_LEN } from "./shareValidation";

const PRESIGN_TTL_SECONDS = 60;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function handlePostSharedUrl(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("malformed request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return new Response("malformed request body", { status: 400 });
  }
  const { share_id: shareIdB64, grant: grantB64 } = body as Record<string, unknown>;
  if (typeof shareIdB64 !== "string" || typeof grantB64 !== "string") {
    return new Response("missing share_id or grant", { status: 400 });
  }

  let shareId: Uint8Array;
  let grantBytes: Uint8Array;
  try {
    shareId = base64UrlDecode(shareIdB64);
    grantBytes = base64UrlDecode(grantB64);
  } catch {
    return new Response("malformed capability or grant", { status: 400 });
  }
  if (shareId.length !== SHARE_ID_LEN) {
    return new Response("malformed capability or grant", { status: 400 });
  }

  const shareIdHash = await sha256(shareId);
  let objectPath: string;
  try {
    objectPath = await openGrant(
      grantBytes,
      shareIdHash,
      decodeBase64Secret(env.SHARE_GRANT_KEY),
    );
  } catch {
    return new Response("malformed capability or grant", { status: 400 });
  }

  const row = await env.DB.prepare(
    "SELECT object_path_hash FROM shares WHERE share_id_hash = ? AND state = 'active'",
  )
    .bind(shareIdHash)
    .first<{ object_path_hash: ArrayBuffer }>();
  const objectPathHash = await sha256(new TextEncoder().encode(objectPath));
  if (!row || base64Encode(row.object_path_hash) !== base64Encode(objectPathHash)) {
    // Uniform failure: an invalid grant, an unknown share_id_hash, and a
    // non-active/stale row must all look identical to the caller
    // (docs/sharing.md §3.3).
    return new Response("no active share for this capability", { status: 404 });
  }

  const mintCredential = createMintCredential(env);
  let credential;
  try {
    credential = await mintCredential(
      "object-read-only",
      { objects: [objectPath] },
      PRESIGN_TTL_SECONDS,
    );
  } catch {
    // Local signing has no network dependency left to fail -- this is
    // always a configuration problem now, not an upstream outage, hence
    // 500 rather than the old 502 (worker/r2CredentialsEndpoint.ts).
    return new Response("failed to mint R2 credential", { status: 500 });
  }

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

  return Response.json(
    {
      url: signed.url,
      expires_at: Math.floor(Date.now() / 1000) + PRESIGN_TTL_SECONDS,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
