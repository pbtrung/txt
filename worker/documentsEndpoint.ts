// docs/data_model.md §3: library listing, one document's content, and
// reading-state updates. GET /v1/documents and GET /v1/documents/:id/content
// are reads (Access session only, docs/auth.md §4.3); PATCH
// /v1/documents/:id/access is mutating (ticket + proof) and implements the
// optimistic-concurrency update docs/data_model.md §4 specifies -- a
// conditional UPDATE on access_version, 412 on conflict.
import { base64Decode, base64Encode } from "./base64";
import type { ProofContext } from "./requireProof";

interface DocumentRow {
  id: number;
  created_at: number;
  access_blob: ArrayBuffer;
  access_version: number;
  access_key_wrapped: ArrayBuffer;
}

// The Library screen never needs a document's content key -- only
// access_blob (for the recency sort) and access_key_id to decrypt it -- so
// this join skips content_key_id entirely. Joining it here too, for every
// row, on every Library-screen load, would bill D1 for a content_key_id
// key_store row nobody reads unless that specific book is actually opened;
// GET /v1/documents/:id/content below fetches that pair lazily, only for
// the one document a reader session actually opens.
const LIBRARY_QUERY = `
  SELECT d.id, d.created_at, d.access_blob, d.access_version,
         ak.wrapped_key AS access_key_wrapped
  FROM documents d
  JOIN key_store ak ON ak.id = d.access_key_id
  ORDER BY d.id
`;

export async function handleGetDocuments(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(LIBRARY_QUERY).all<DocumentRow>();
  return Response.json({
    documents: results.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      access_blob: base64Encode(row.access_blob),
      access_version: row.access_version,
      access_key_wrapped: base64Encode(row.access_key_wrapped),
    })),
  });
}

interface DocumentContentRow {
  content_blob: ArrayBuffer;
  content_key_wrapped: ArrayBuffer;
}

const CONTENT_QUERY = `
  SELECT d.content_blob, ck.wrapped_key AS content_key_wrapped
  FROM documents d
  JOIN key_store ck ON ck.id = d.content_key_id
  WHERE d.id = ?
`;

export async function handleGetDocumentContent(
  env: Env,
  idParam: string,
): Promise<Response> {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("invalid document id", { status: 400 });
  }
  const row = await env.DB.prepare(CONTENT_QUERY).bind(id).first<DocumentContentRow>();
  if (!row) {
    return new Response("document not found", { status: 404 });
  }
  return Response.json({
    content_blob: base64Encode(row.content_blob),
    content_key_wrapped: base64Encode(row.content_key_wrapped),
  });
}

export async function handlePatchDocumentAccess(
  env: Env,
  idParam: string,
  proof: ProofContext,
): Promise<Response> {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("invalid document id", { status: 400 });
  }
  const accessBlobB64 = proof.bodyJson.access_blob;
  const accessVersion = proof.bodyJson.access_version;
  if (
    typeof accessBlobB64 !== "string" ||
    typeof accessVersion !== "number" ||
    !Number.isInteger(accessVersion) ||
    accessVersion < 0
  ) {
    return new Response("missing or invalid access_blob/access_version", {
      status: 400,
    });
  }
  let accessBlob: Uint8Array;
  try {
    accessBlob = base64Decode(accessBlobB64);
  } catch {
    return new Response("malformed access_blob", { status: 400 });
  }

  const { meta } = await env.DB.prepare(
    `UPDATE documents SET access_blob = ?, access_version = access_version + 1
     WHERE id = ? AND access_version = ?`,
  )
    .bind(accessBlob, id, accessVersion)
    .run();

  if (meta.changes === 0) {
    const exists = await env.DB.prepare("SELECT 1 FROM documents WHERE id = ?")
      .bind(id)
      .first();
    return new Response(exists ? "access_version conflict" : "document not found", {
      status: exists ? 412 : 404,
    });
  }

  return Response.json({ access_version: accessVersion + 1 });
}
