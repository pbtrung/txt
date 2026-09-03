// docs/data_model.md §2.2: bookmark listing (read) and create/delete
// (mutating, ticket + proof). Re-bookmarking the same CFI is enforced
// client-side, not here -- the Worker never holds an unwrapped key, so it
// cannot decrypt bookmark_blob to compare CFIs itself (docs/auth.md's
// trust boundary); the client, which already has every bookmark's
// decrypted CFI from its last listing fetch, deletes the old row before
// creating the new one when it finds a match.
import { base64Decode, base64Encode } from "./base64";
import type { ProofContext } from "./requireProof";

interface BookmarkRow {
  id: number;
  created_at: number;
  key_wrapped: ArrayBuffer;
  bookmark_blob: ArrayBuffer;
}

const BOOKMARKS_QUERY = `
  SELECT b.id, b.created_at, k.wrapped_key AS key_wrapped, b.bookmark_blob
  FROM bookmarks b
  JOIN key_store k ON k.id = b.key_id
  WHERE b.document_id = ?
  ORDER BY b.created_at, b.id
`;

export async function handleGetBookmarks(env: Env, url: URL): Promise<Response> {
  const documentId = Number(url.searchParams.get("document_id"));
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return new Response("missing or invalid document_id", { status: 400 });
  }
  const { results } = await env.DB.prepare(BOOKMARKS_QUERY)
    .bind(documentId)
    .all<BookmarkRow>();
  return Response.json({
    bookmarks: results.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      key_wrapped: base64Encode(row.key_wrapped),
      bookmark_blob: base64Encode(row.bookmark_blob),
    })),
  });
}

interface BookmarkSummaryRow {
  id: number;
  document_id: number;
  key_wrapped: ArrayBuffer;
  bookmark_blob: ArrayBuffer;
  created_at: number;
  count: number;
}

// One row per document that has at least one bookmark: its total count
// (a plaintext aggregate -- no decryption needed) and its single latest
// bookmark's id + wrapped key + blob (the id lets the client delete this
// exact bookmark directly, without a separate lookup), for the Library
// screen's bookmark badge and "recently bookmarked" section without an
// N+1 fetch across every book.
const BOOKMARKS_SUMMARY_QUERY = `
  SELECT id, document_id, key_wrapped, bookmark_blob, created_at, count
  FROM (
    SELECT b.id, b.document_id, k.wrapped_key AS key_wrapped, b.bookmark_blob, b.created_at,
           COUNT(*) OVER (PARTITION BY b.document_id) AS count,
           ROW_NUMBER() OVER (
             PARTITION BY b.document_id ORDER BY b.created_at DESC, b.id DESC
           ) AS rn
    FROM bookmarks b
    JOIN key_store k ON k.id = b.key_id
  )
  WHERE rn = 1
`;

export async function handleGetBookmarksSummary(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    BOOKMARKS_SUMMARY_QUERY,
  ).all<BookmarkSummaryRow>();
  return Response.json({
    summaries: results.map((row) => ({
      id: row.id,
      document_id: row.document_id,
      count: row.count,
      key_wrapped: base64Encode(row.key_wrapped),
      bookmark_blob: base64Encode(row.bookmark_blob),
      created_at: row.created_at,
    })),
  });
}

export async function handlePostBookmark(
  env: Env,
  proof: ProofContext,
): Promise<Response> {
  const documentId = proof.bodyJson.document_id;
  const keyWrappedB64 = proof.bodyJson.key_wrapped;
  const bookmarkBlobB64 = proof.bodyJson.bookmark_blob;
  if (
    typeof documentId !== "number" ||
    !Number.isInteger(documentId) ||
    typeof keyWrappedB64 !== "string" ||
    typeof bookmarkBlobB64 !== "string"
  ) {
    return new Response("missing or invalid document_id/key_wrapped/bookmark_blob", {
      status: 400,
    });
  }
  let keyWrapped: Uint8Array;
  let bookmarkBlob: Uint8Array;
  try {
    keyWrapped = base64Decode(keyWrappedB64);
    bookmarkBlob = base64Decode(bookmarkBlobB64);
  } catch {
    return new Response("malformed key_wrapped/bookmark_blob", { status: 400 });
  }

  // One D1 batch (not two separate statements): docs/data_model.md §4's
  // atomicity guarantee only covers a single statement or batch, and
  // nothing else in this schema reconciles a key_store row left behind
  // by an interruption between two independently-awaited statements.
  // last_insert_rowid() lets the second statement reference the first's
  // id within the same batch/transaction.
  try {
    const [, bookmarkResult] = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES ('bookmark_key', ?, ?)",
      ).bind(keyWrapped, Date.now()),
      env.DB.prepare(
        "INSERT INTO bookmarks (document_id, created_at, key_id, bookmark_blob) VALUES (?, ?, last_insert_rowid(), ?)",
      ).bind(documentId, Date.now(), bookmarkBlob),
    ]);
    return Response.json({ id: bookmarkResult.meta.last_row_id });
  } catch {
    // documentId doesn't reference a real documents row -- the whole
    // batch (including the key_store insert) rolled back atomically.
    return new Response("invalid document_id", { status: 400 });
  }
}

export async function handleDeleteBookmark(
  env: Env,
  idParam: string,
): Promise<Response> {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("invalid bookmark id", { status: 400 });
  }
  // Idempotent: deleting an already-gone bookmark is still success -- the
  // caller's desired end state (no such bookmark) already holds.
  await env.DB.prepare("DELETE FROM bookmarks WHERE id = ?").bind(id).run();
  return new Response(null, { status: 204 });
}
