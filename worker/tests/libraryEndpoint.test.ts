// GET /v1/library: the Library screen's combined recently-accessed
// listing, singleton catalog row, and bookmarks summary, through the
// real fetch() handler. Each query's own correctness (the recent-access
// join, the catalog lookup, the bookmarks-summary window functions) is
// covered here rather than duplicated -- there's no route left that
// exercises them individually.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64Encode } from "../base64";
import { mockAccessCertsEndpoint, signTestAccessToken } from "./testAccessToken";

function blob(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function insertKey(
  purpose: string,
): Promise<{ id: number; wrapped: Uint8Array }> {
  const wrapped = blob(48);
  const { meta } = await env.DB.prepare(
    "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES (?, ?, ?)",
  )
    .bind(purpose, wrapped, Date.now())
    .run();
  return { id: meta.last_row_id, wrapped };
}

async function insertDocument(): Promise<{
  id: number;
  accessBlob: Uint8Array;
  accessKeyWrapped: Uint8Array;
}> {
  const contentKey = await insertKey("content_key");
  const accessKey = await insertKey("access_key");
  const accessBlob = blob(32);
  const { meta } = await env.DB.prepare(
    `INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id, access_blob)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(Date.now(), contentKey.id, blob(32), accessKey.id, accessBlob)
    .run();
  return { id: meta.last_row_id, accessBlob, accessKeyWrapped: accessKey.wrapped };
}

async function insertDocumentWithoutAccess(): Promise<number> {
  const contentKey = await insertKey("content_key");
  const { meta } = await env.DB.prepare(
    "INSERT INTO documents (created_at, content_key_id, content_blob) VALUES (?, ?, ?)",
  )
    .bind(Date.now(), contentKey.id, blob(32))
    .run();
  return meta.last_row_id;
}

async function insertBookmark(documentId: number, createdAt: number): Promise<number> {
  const key = await insertKey("bookmark_key");
  const { meta } = await env.DB.prepare(
    "INSERT INTO bookmarks (document_id, created_at, key_id, bookmark_blob) VALUES (?, ?, ?, ?)",
  )
    .bind(documentId, createdAt, key.id, blob(32))
    .run();
  return meta.last_row_id;
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

interface LibraryBody {
  documents: { id: number; access_blob: string; access_key_wrapped: string }[];
  catalog: { key_wrapped: string; catalog_blob: string } | null;
  summaries: { document_id: number; count: number }[];
}

describe("GET /v1/library", () => {
  it("returns empty documents/summaries and a null catalog for a fresh library", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/library", { headers });
      expect(response.status).toBe(200);
      const body = (await response.json()) as LibraryBody;
      expect(body.catalog).toBeNull();
      // D1 storage carries over from earlier tests in this file (only
      // reset between files) -- assert on the specific rows this test
      // just inserted (none), not an assumed-empty overall count.
      expect(body.documents).toEqual([]);
    } finally {
      restore();
    }
  });

  it("includes an accessed document's joined access key, excludes a never-opened one", async () => {
    const accessed = await insertDocument();
    const unopened = await insertDocumentWithoutAccess();
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/library", { headers });
      const body = (await response.json()) as LibraryBody;
      const row = body.documents.find((r) => r.id === accessed.id);
      expect(row?.access_blob).toBe(base64Encode(accessed.accessBlob));
      expect(row?.access_key_wrapped).toBe(base64Encode(accessed.accessKeyWrapped));
      expect(body.documents.find((r) => r.id === unopened)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("returns the catalog row joined against its wrapped key", async () => {
    const wrappedKey = blob(48);
    const catalogBlob = blob(32);
    const { meta } = await env.DB.prepare(
      "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES (?, ?, ?)",
    )
      .bind("catalog_key", wrappedKey, Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO catalog (singleton, key_id, catalog_blob, updated_at) VALUES (1, ?, ?, ?)",
    )
      .bind(meta.last_row_id, catalogBlob, Date.now())
      .run();

    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/library", { headers });
      const body = (await response.json()) as LibraryBody;
      expect(body.catalog).toEqual({
        key_wrapped: base64Encode(wrappedKey),
        catalog_blob: base64Encode(catalogBlob),
      });
    } finally {
      restore();
    }
  });

  it("summarizes a document's bookmarks alongside the other two queries", async () => {
    const document = await insertDocument();
    await insertBookmark(document.id, 1000);
    await insertBookmark(document.id, 2000);

    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/library", { headers });
      const body = (await response.json()) as LibraryBody;
      const summary = body.summaries.find((row) => row.document_id === document.id);
      expect(summary?.count).toBe(2);
    } finally {
      restore();
    }
  });

  it("rejects a request with no Access session", async () => {
    const response = await SELF.fetch("https://example.com/v1/library");
    expect(response.status).toBe(401);
  });
});
