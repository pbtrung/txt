// docs/sharing.md §3.1/§3.2/§3.4: listing, creating, and revoking shares.
// The Worker never decrypts `owner_blob` -- it's opaque, client-encrypted
// bytes (docs/auth.md's trust boundary; docs/sharing.md was corrected to
// say so while implementing this). Every plaintext value the Worker
// needs (share_id, share_path, document_id) travels as its own body
// field instead.
import { sealGrant } from "./shareGrant";
import { base64Decode, base64Encode, base64UrlDecode, base64UrlEncode } from "./base64";
import { decodeBase64Secret } from "./ownerEndpoint";
import { isValidSharePath, SHARE_ID_LEN } from "./shareValidation";
import type { ProofContext } from "./requireProof";

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function requireBucket(env: Env): R2Bucket {
  if (!env.BUCKET) {
    throw new Error("BUCKET is not configured");
  }
  return env.BUCKET;
}

interface ShareRow {
  share_id_hash: ArrayBuffer;
  document_id: number;
  key_wrapped: ArrayBuffer;
  owner_blob: ArrayBuffer;
  state: string;
  created_at: number;
}

const SHARES_QUERY = `
  SELECT s.share_id_hash, s.document_id, k.wrapped_key AS key_wrapped,
         s.owner_blob, s.state, s.created_at
  FROM shares s
  JOIN key_store k ON k.id = s.key_id
  ORDER BY s.created_at, s.share_id_hash
`;

export async function handleGetShares(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(SHARES_QUERY).all<ShareRow>();
  return Response.json({
    shares: results.map((row) => ({
      share_id_hash: base64Encode(row.share_id_hash),
      document_id: row.document_id,
      key_wrapped: base64Encode(row.key_wrapped),
      owner_blob: base64Encode(row.owner_blob),
      state: row.state,
      created_at: row.created_at,
    })),
  });
}

function parseShareBody(
  body: Record<string, unknown>,
): { documentId: number; shareId: Uint8Array; sharePath: string } | null {
  const { document_id: documentId, share_id: shareIdB64, share_path: sharePath } = body;
  if (
    typeof documentId !== "number" ||
    !Number.isInteger(documentId) ||
    typeof shareIdB64 !== "string" ||
    typeof sharePath !== "string" ||
    !isValidSharePath(sharePath)
  ) {
    return null;
  }
  let shareId: Uint8Array;
  try {
    shareId = base64UrlDecode(shareIdB64);
  } catch {
    return null;
  }
  if (shareId.length !== SHARE_ID_LEN) {
    return null;
  }
  return { documentId, shareId, sharePath };
}

export async function handlePostShares(
  env: Env,
  proof: ProofContext,
): Promise<Response> {
  const parsed = parseShareBody(proof.bodyJson);
  const keyWrappedB64 = proof.bodyJson.key_wrapped;
  const ownerBlobB64 = proof.bodyJson.owner_blob;
  if (
    !parsed ||
    typeof keyWrappedB64 !== "string" ||
    typeof ownerBlobB64 !== "string"
  ) {
    return new Response("missing or invalid share fields", { status: 400 });
  }
  const { documentId, shareId, sharePath } = parsed;

  const objectPath = `${proof.dbPrefix}/shared/${sharePath}`;
  const shareIdHash = await sha256(shareId);
  const objectPathHash = await sha256(new TextEncoder().encode(objectPath));

  const existing = await env.DB.prepare(
    "SELECT document_id, object_path_hash FROM shares WHERE share_id_hash = ?",
  )
    .bind(shareIdHash)
    .first<{ document_id: number; object_path_hash: ArrayBuffer }>();

  if (existing) {
    const sameMaterial =
      existing.document_id === documentId &&
      base64Encode(existing.object_path_hash) === base64Encode(objectPathHash);
    if (!sameMaterial) {
      return new Response("share_id reused for different material", { status: 409 });
    }
  } else {
    const { meta: keyMeta } = await env.DB.prepare(
      "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES ('share_key', ?, ?)",
    )
      .bind(base64Decode(keyWrappedB64), Date.now())
      .run();
    try {
      await env.DB.prepare(
        `INSERT INTO shares (share_id_hash, document_id, object_path_hash, key_id, owner_blob, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
        .bind(
          shareIdHash,
          documentId,
          objectPathHash,
          keyMeta.last_row_id,
          base64Decode(ownerBlobB64),
          Date.now(),
        )
        .run();
    } catch (error) {
      await env.DB.prepare("DELETE FROM key_store WHERE id = ?")
        .bind(keyMeta.last_row_id)
        .run();
      const message = error instanceof Error ? error.message : "";
      if (message.includes("object_path_hash")) {
        return new Response("path reused for different material", { status: 409 });
      }
      return new Response("invalid document_id", { status: 400 });
    }
  }

  const grant = await sealGrant(
    objectPath,
    shareIdHash,
    decodeBase64Secret(env.SHARE_GRANT_KEY),
  );
  return Response.json({ registered: true, grant: base64UrlEncode(grant) });
}

export async function handleDeleteShares(
  env: Env,
  proof: ProofContext,
): Promise<Response> {
  const parsed = parseShareBody(proof.bodyJson);
  if (!parsed) {
    return new Response("missing or invalid share fields", { status: 400 });
  }
  const { documentId, shareId, sharePath } = parsed;
  const shareIdHash = await sha256(shareId);

  const row = await env.DB.prepare(
    "SELECT document_id, object_path_hash, state FROM shares WHERE share_id_hash = ?",
  )
    .bind(shareIdHash)
    .first<{ document_id: number; object_path_hash: ArrayBuffer; state: string }>();
  if (!row) {
    // Already absent -- indistinguishable from a successful revocation.
    return new Response(null, { status: 204 });
  }

  const objectPath = `${proof.dbPrefix}/shared/${sharePath}`;
  const objectPathHash = await sha256(new TextEncoder().encode(objectPath));
  if (
    row.document_id !== documentId ||
    base64Encode(row.object_path_hash) !== base64Encode(objectPathHash)
  ) {
    return new Response("document_id/share_path does not match this share", {
      status: 400,
    });
  }
  if (row.state !== "active") {
    return new Response("share is not active", { status: 409 });
  }

  const { meta } = await env.DB.prepare(
    "UPDATE shares SET state = 'deleting' WHERE share_id_hash = ? AND state = 'active'",
  )
    .bind(shareIdHash)
    .run();
  if (meta.changes === 0) {
    // Raced with a concurrent transition away from 'active'.
    return new Response("share is not active", { status: 409 });
  }

  try {
    // R2's delete() is idempotent for a missing key -- no separate 404
    // handling needed for that case (docs/sharing.md §3.4).
    await requireBucket(env).delete(objectPath);
  } catch {
    // Row stays 'deleting': already revoked, retryable (docs/sharing.md §3.4).
    return new Response("R2 deletion failed, retry", { status: 503 });
  }

  await env.DB.prepare("DELETE FROM shares WHERE share_id_hash = ?")
    .bind(shareIdHash)
    .run();
  return new Response(null, { status: 204 });
}
