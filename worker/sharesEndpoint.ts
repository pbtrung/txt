// docs/sharing.md §3.1/§3.2/§3.4: listing, creating, and revoking shares.
// The Worker never decrypts `owner_blob` -- it's opaque, client-encrypted
// bytes (docs/auth.md's trust boundary; docs/sharing.md was corrected to
// say so while implementing this). Every plaintext value the Worker
// needs (share_id, share_path, document_id) travels as its own body
// field instead.
import { sealGrant } from "./shareGrant";
import {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  sha256,
} from "./base64";
import { isValidSharePath, SHARE_ID_LEN } from "./shareValidation";
import type { ProofContext } from "./requireProof";
import { requireBinding } from "./requireVar";

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

interface ExistingShare {
  document_id: number;
  object_path_hash: ArrayBuffer;
  state: string;
}

async function lookupShare(
  env: Env,
  shareIdHash: Uint8Array,
): Promise<ExistingShare | null> {
  return env.DB.prepare(
    "SELECT document_id, object_path_hash, state FROM shares WHERE share_id_hash = ?",
  )
    .bind(shareIdHash)
    .first<ExistingShare>();
}

function sameMaterial(
  existing: ExistingShare,
  documentId: number,
  objectPathHash: Uint8Array,
): boolean {
  return (
    existing.document_id === documentId &&
    base64Encode(existing.object_path_hash) === base64Encode(objectPathHash)
  );
}

// A row idempotently replayed while stuck in 'deleting' (a prior revoke's
// D1 transition succeeded but its R2 delete didn't, docs/sharing.md §3.4)
// is reactivated rather than left to mint a grant that would 404 forever
// at /v1/shared-url. Re-checks after the conditional UPDATE rather than
// trusting its own change count, since a concurrent revoke could have
// deleted the row for real in between.
async function reactivateIfNeeded(
  env: Env,
  shareIdHash: Uint8Array,
  state: string,
): Promise<"active" | "gone"> {
  if (state === "active") return "active";
  await env.DB.prepare(
    "UPDATE shares SET state = 'active' WHERE share_id_hash = ? AND state != 'active'",
  )
    .bind(shareIdHash)
    .run();
  const row = await env.DB.prepare("SELECT state FROM shares WHERE share_id_hash = ?")
    .bind(shareIdHash)
    .first<{ state: string }>();
  return row?.state === "active" ? "active" : "gone";
}

async function respondToExistingShare(
  env: Env,
  existing: ExistingShare,
  documentId: number,
  objectPathHash: Uint8Array,
  shareIdHash: Uint8Array,
): Promise<Response | null> {
  if (!sameMaterial(existing, documentId, objectPathHash)) {
    return new Response("share_id reused for different material", { status: 409 });
  }
  const status = await reactivateIfNeeded(env, shareIdHash, existing.state);
  if (status === "gone") {
    return new Response("share was concurrently revoked, retry", { status: 409 });
  }
  return null;
}

interface NewShareFields {
  shareIdHash: Uint8Array;
  documentId: number;
  objectPathHash: Uint8Array;
  keyWrapped: Uint8Array;
  ownerBlob: Uint8Array;
}

// A conflict here means a concurrent request already won an insert this
// one collided with. Re-check by our *own* share_id_hash first, rather
// than branching on which constraint the D1 error message names: a
// concurrent request for this exact share_id (the common case this
// exists to fix) collides on both share_id_hash and object_path_hash at
// once, and which one D1's error text happens to mention isn't something
// to depend on. Only when no row exists under our own share_id_hash is
// the conflict genuinely about a different share_id's object_path_hash.
async function responseForInsertConflict(
  error: unknown,
  env: Env,
  fields: NewShareFields,
): Promise<Response | null> {
  const existing = await lookupShare(env, fields.shareIdHash);
  if (existing) {
    return respondToExistingShare(
      env,
      existing,
      fields.documentId,
      fields.objectPathHash,
      fields.shareIdHash,
    );
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("object_path_hash")) {
    return new Response("path reused for different material", { status: 409 });
  }
  return new Response("invalid document_id", { status: 400 });
}

// One D1 batch (not two separate statements): docs/data_model.md §4's
// atomicity guarantee only covers a single statement or batch, and
// nothing else in this schema reconciles a key_store row left behind by
// an interruption between two independently-awaited statements.
// last_insert_rowid() lets the second statement reference the first's id
// within the same batch/transaction.
async function insertNewShare(
  env: Env,
  fields: NewShareFields,
): Promise<Response | null> {
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES ('share_key', ?, ?)",
      ).bind(fields.keyWrapped, Date.now()),
      env.DB.prepare(
        `INSERT INTO shares (share_id_hash, document_id, object_path_hash, key_id, owner_blob, state, created_at)
         VALUES (?, ?, ?, last_insert_rowid(), ?, 'active', ?)`,
      ).bind(
        fields.shareIdHash,
        fields.documentId,
        fields.objectPathHash,
        fields.ownerBlob,
        Date.now(),
      ),
    ]);
    return null;
  } catch (error) {
    return responseForInsertConflict(error, env, fields);
  }
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
  let keyWrapped: Uint8Array;
  let ownerBlob: Uint8Array;
  try {
    keyWrapped = base64Decode(keyWrappedB64);
    ownerBlob = base64Decode(ownerBlobB64);
  } catch {
    return new Response("malformed key_wrapped/owner_blob", { status: 400 });
  }
  const { documentId, shareId, sharePath } = parsed;

  const objectPath = `${proof.dbPrefix}/shared/${sharePath}`;
  const shareIdHash = await sha256(shareId);
  const objectPathHash = await sha256(new TextEncoder().encode(objectPath));
  const fields: NewShareFields = {
    shareIdHash,
    documentId,
    objectPathHash,
    keyWrapped,
    ownerBlob,
  };

  const existing = await lookupShare(env, shareIdHash);
  const conflict = existing
    ? await respondToExistingShare(
        env,
        existing,
        documentId,
        objectPathHash,
        shareIdHash,
      )
    : await insertNewShare(env, fields);
  if (conflict) {
    return conflict;
  }

  const grant = await sealGrant(
    objectPath,
    shareIdHash,
    base64Decode(env.SHARE_GRANT_KEY),
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
    await requireBinding(env.BUCKET, "BUCKET").delete(objectPath);
  } catch {
    // Row stays 'deleting': already revoked, retryable (docs/sharing.md §3.4).
    return new Response("R2 deletion failed, retry", { status: 503 });
  }

  await env.DB.prepare("DELETE FROM shares WHERE share_id_hash = ?")
    .bind(shareIdHash)
    .run();
  return new Response(null, { status: 204 });
}
