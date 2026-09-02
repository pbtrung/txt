// GET /v1/bookmarks/summary: one row per document with a bookmark, its
// count and its single latest bookmark's wrapped key + blob, through the
// real fetch() handler.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64Encode } from "../base64";
import { mockAccessCertsEndpoint, signTestAccessToken } from "./testAccessToken";

function blob(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function insertKey(purpose: string): Promise<number> {
  const { meta } = await env.DB.prepare(
    "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES (?, ?, ?)",
  )
    .bind(purpose, blob(48), Date.now())
    .run();
  return meta.last_row_id;
}

async function insertDocument(): Promise<number> {
  const contentKeyId = await insertKey("content_key");
  const accessKeyId = await insertKey("access_key");
  const { meta } = await env.DB.prepare(
    `INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id, access_blob)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(Date.now(), contentKeyId, blob(32), accessKeyId, blob(32))
    .run();
  return meta.last_row_id;
}

async function insertBookmark(
  documentId: number,
  createdAt: number,
): Promise<{ id: number; keyWrapped: Uint8Array; bookmarkBlob: Uint8Array }> {
  const keyId = await insertKey("bookmark_key");
  const keyRow = await env.DB.prepare("SELECT wrapped_key FROM key_store WHERE id = ?")
    .bind(keyId)
    .first<{ wrapped_key: ArrayBuffer }>();
  const bookmarkBlob = blob(32);
  const { meta } = await env.DB.prepare(
    "INSERT INTO bookmarks (document_id, created_at, key_id, bookmark_blob) VALUES (?, ?, ?, ?)",
  )
    .bind(documentId, createdAt, keyId, bookmarkBlob)
    .run();
  return {
    id: meta.last_row_id,
    keyWrapped: new Uint8Array(keyRow!.wrapped_key),
    bookmarkBlob,
  };
}

async function accessSession(): Promise<{ restore: () => void; headers: HeadersInit }> {
  const restore = mockAccessCertsEndpoint();
  const token = await signTestAccessToken({
    email: env.OWNER_EMAIL,
    aud: [env.CF_ACCESS_AUD],
    iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return { restore, headers: { "Cf-Access-Jwt-Assertion": token } };
}

describe("GET /v1/bookmarks/summary", () => {
  it("returns an empty list when no document has a bookmark", async () => {
    const documentId = await insertDocument();
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/bookmarks/summary", {
        headers,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        summaries: { document_id: number }[];
      };
      expect(body.summaries.some((row) => row.document_id === documentId)).toBe(false);
    } finally {
      restore();
    }
  });

  it("returns the count and latest bookmark for a document with several bookmarks", async () => {
    const documentId = await insertDocument();
    await insertBookmark(documentId, 1000);
    await insertBookmark(documentId, 2000);
    const latest = await insertBookmark(documentId, 3000);

    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/bookmarks/summary", {
        headers,
      });
      const body = (await response.json()) as {
        summaries: {
          id: number;
          document_id: number;
          count: number;
          key_wrapped: string;
          bookmark_blob: string;
          created_at: number;
        }[];
      };
      const row = body.summaries.find((r) => r.document_id === documentId);
      expect(row).toBeDefined();
      expect(row?.id).toBe(latest.id);
      expect(row?.count).toBe(3);
      expect(row?.created_at).toBe(3000);
      expect(row?.key_wrapped).toBe(base64Encode(latest.keyWrapped));
      expect(row?.bookmark_blob).toBe(base64Encode(latest.bookmarkBlob));
    } finally {
      restore();
    }
  });

  it("keeps each document's summary independent of other documents' bookmarks", async () => {
    const documentA = await insertDocument();
    const documentB = await insertDocument();
    await insertBookmark(documentA, 1000);
    await insertBookmark(documentB, 2000);
    await insertBookmark(documentB, 2500);

    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/bookmarks/summary", {
        headers,
      });
      const body = (await response.json()) as {
        summaries: { document_id: number; count: number }[];
      };
      expect(body.summaries.find((r) => r.document_id === documentA)?.count).toBe(1);
      expect(body.summaries.find((r) => r.document_id === documentB)?.count).toBe(2);
    } finally {
      restore();
    }
  });

  it("rejects a request with no Access session", async () => {
    const response = await SELF.fetch("https://example.com/v1/bookmarks/summary");
    expect(response.status).toBe(401);
  });
});
