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
  access_blob: ArrayBuffer | null;
  access_version: number;
  access_key_wrapped: ArrayBuffer | null;
}

// The Library screen never needs a document's content key -- only
// access_blob (for the recency sort) and access_key_id to decrypt it -- so
// this join skips content_key_id entirely. Joining it here too, for every
// row, on every Library-screen load, would bill D1 for a content_key_id
// key_store row nobody reads unless that specific book is actually opened;
// GET /v1/documents/:id/content below fetches that pair lazily, only for
// the one document a reader session actually opens. A LEFT JOIN, not an
// INNER JOIN: a document nobody has ever opened has no access_key_id at
// all (docs/data_model.md §2), and must still be listed.
const LIBRARY_QUERY_BASE = `
  SELECT d.id, d.created_at, d.access_blob, d.access_version,
         ak.wrapped_key AS access_key_wrapped
  FROM documents d
  LEFT JOIN key_store ak ON ak.id = d.access_key_id
`;

function documentJson(row: DocumentRow) {
  return {
    id: row.id,
    created_at: row.created_at,
    access_blob: row.access_blob === null ? null : base64Encode(row.access_blob),
    access_version: row.access_version,
    access_key_wrapped:
      row.access_key_wrapped === null ? null : base64Encode(row.access_key_wrapped),
  };
}

export async function handleGetDocuments(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `${LIBRARY_QUERY_BASE} ORDER BY d.id`,
  ).all<DocumentRow>();
  return Response.json({ documents: results.map(documentJson) });
}

// One document's own row, in the exact shape LIBRARY_QUERY returns for
// it -- used to refresh a single document's access_blob/access_version
// after a 412 conflict (docs/data_model.md §4) without re-reading every
// other document in the library just to find the one that changed.
export async function handleGetDocument(env: Env, idParam: string): Promise<Response> {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("invalid document id", { status: 400 });
  }
  const row = await env.DB.prepare(`${LIBRARY_QUERY_BASE} WHERE d.id = ?`)
    .bind(id)
    .first<DocumentRow>();
  if (!row) {
    return new Response("document not found", { status: 404 });
  }
  return Response.json(documentJson(row));
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

// A write is one of three shapes, discriminated by which fields are
// present: {access_version} alone clears access state back to NULL
// (docs/data_model.md §2); {access_blob, access_version} updates an
// existing access_key_id in place; {access_blob, access_version,
// access_key_wrapped} is a document's first-ever write, minting a fresh
// access_key_id since none exists yet.
type AccessWrite =
  | { kind: "clear" }
  | { kind: "update"; accessBlob: Uint8Array }
  | { kind: "first"; accessBlob: Uint8Array; accessKeyWrapped: Uint8Array };

function parseAccessWrite(body: Record<string, unknown>): AccessWrite | null {
  if (body.access_blob === undefined) return { kind: "clear" };
  if (typeof body.access_blob !== "string") return null;
  let accessBlob: Uint8Array;
  try {
    accessBlob = base64Decode(body.access_blob);
  } catch {
    return null;
  }
  if (body.access_key_wrapped === undefined) return { kind: "update", accessBlob };
  if (typeof body.access_key_wrapped !== "string") return null;
  try {
    return {
      kind: "first",
      accessBlob,
      accessKeyWrapped: base64Decode(body.access_key_wrapped),
    };
  } catch {
    return null;
  }
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
  const accessVersion = proof.bodyJson.access_version;
  if (
    typeof accessVersion !== "number" ||
    !Number.isInteger(accessVersion) ||
    accessVersion < 0
  ) {
    return new Response("missing or invalid access_version", { status: 400 });
  }
  const write = parseAccessWrite(proof.bodyJson);
  if (write === null) {
    return new Response("missing or invalid access_blob/access_key_wrapped", {
      status: 400,
    });
  }
  if (write.kind === "clear") return clearDocumentAccess(env, id, accessVersion);
  if (write.kind === "first") {
    return firstAccessWrite(
      env,
      id,
      accessVersion,
      write.accessBlob,
      write.accessKeyWrapped,
    );
  }
  return updateDocumentAccess(env, id, accessVersion, write.accessBlob);
}

async function updateDocumentAccess(
  env: Env,
  id: number,
  accessVersion: number,
  accessBlob: Uint8Array,
): Promise<Response> {
  const { meta } = await env.DB.prepare(
    `UPDATE documents SET access_blob = ?, access_version = access_version + 1
     WHERE id = ? AND access_version = ? AND access_key_id IS NOT NULL`,
  )
    .bind(accessBlob, id, accessVersion)
    .run();
  if (meta.changes === 0) return conflictOrNotFoundResponse(env, id);
  return Response.json({ access_version: accessVersion + 1 });
}

// A document's first-ever reading-state write: no access_key_id exists
// yet, so this mints one in the same D1 batch as the conditional UPDATE
// that sets it (docs/data_model.md §4's atomicity guarantee only covers
// a single statement or batch -- mirrors handlePostBookmark in
// bookmarksEndpoint.ts). If the UPDATE doesn't match (already has a key,
// wrong version, or the document doesn't exist), the key_store row just
// minted is orphaned and gets cleaned up explicitly.
async function firstAccessWrite(
  env: Env,
  id: number,
  accessVersion: number,
  accessBlob: Uint8Array,
  accessKeyWrapped: Uint8Array,
): Promise<Response> {
  const [keyResult, updateResult] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES ('access_key', ?, ?)",
    ).bind(accessKeyWrapped, Date.now()),
    env.DB.prepare(
      `UPDATE documents SET access_key_id = last_insert_rowid(), access_blob = ?,
       access_version = access_version + 1
       WHERE id = ? AND access_version = ? AND access_key_id IS NULL`,
    ).bind(accessBlob, id, accessVersion),
  ]);
  if (updateResult.meta.changes === 0) {
    await env.DB.prepare("DELETE FROM key_store WHERE id = ?")
      .bind(keyResult.meta.last_row_id)
      .run();
    return conflictOrNotFoundResponse(env, id);
  }
  return Response.json({ access_version: accessVersion + 1 });
}

// Explicitly forgets a document's reading state (LibraryStore.
// clearLastAccessed()): access_key_id back to NULL fires
// trg_documents_clear_access_key, so the old key_store row is cleaned up
// by the schema itself, not tracked here.
async function clearDocumentAccess(
  env: Env,
  id: number,
  accessVersion: number,
): Promise<Response> {
  const { meta } = await env.DB.prepare(
    `UPDATE documents SET access_blob = NULL, access_key_id = NULL,
     access_version = access_version + 1
     WHERE id = ? AND access_version = ?`,
  )
    .bind(id, accessVersion)
    .run();
  if (meta.changes === 0) return conflictOrNotFoundResponse(env, id);
  return Response.json({ access_version: accessVersion + 1 });
}

async function conflictOrNotFoundResponse(env: Env, id: number): Promise<Response> {
  const exists = await env.DB.prepare("SELECT 1 FROM documents WHERE id = ?")
    .bind(id)
    .first();
  return new Response(exists ? "access_version conflict" : "document not found", {
    status: exists ? 412 : 404,
  });
}
