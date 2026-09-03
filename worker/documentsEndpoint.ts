// docs/data_model.md §3: library listing and reading-state updates.
// GET /v1/documents is a read (Access session only, docs/auth.md §4.3);
// PATCH /v1/documents/:id/access is mutating (ticket + proof) and
// implements the optimistic-concurrency update docs/data_model.md §4
// specifies -- a conditional UPDATE on access_version, 412 on conflict.
import { base64Decode, base64Encode } from "./base64";
import type { ProofContext } from "./requireProof";

interface DocumentRow {
  id: number;
  created_at: number;
  content_blob: ArrayBuffer;
  content_key_wrapped: ArrayBuffer;
  access_blob: ArrayBuffer;
  access_version: number;
  access_key_wrapped: ArrayBuffer;
}

// One query joining documents against key_store on both foreign keys
// (docs/data_model.md §3, "avoiding N+1") rather than a per-row follow-up
// query for each document's wrapped keys.
const LIBRARY_QUERY = `
  SELECT d.id, d.created_at, d.content_blob, ck.wrapped_key AS content_key_wrapped,
         d.access_blob, d.access_version, ak.wrapped_key AS access_key_wrapped
  FROM documents d
  JOIN key_store ck ON ck.id = d.content_key_id
  JOIN key_store ak ON ak.id = d.access_key_id
  ORDER BY d.id
`;

export async function handleGetDocuments(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(LIBRARY_QUERY).all<DocumentRow>();
  return Response.json({
    documents: results.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      content_blob: base64Encode(row.content_blob),
      content_key_wrapped: base64Encode(row.content_key_wrapped),
      access_blob: base64Encode(row.access_blob),
      access_version: row.access_version,
      access_key_wrapped: base64Encode(row.access_key_wrapped),
    })),
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
