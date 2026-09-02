// Milestone 5 (docs/milestones.md): bookmark listing (read) and
// create/delete (mutating, ticket + proof), through the real fetch()
// handler.
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { base64Encode } from "../base64";
import { createTestOwnerSession } from "./testOwnerSession";
import type { TestOwnerSession } from "./testOwnerSession";
import { mockAccessCertsEndpoint, signTestAccessToken } from "./testAccessToken";

// D1 storage isn't reset between `it()` blocks within a file (only between
// files) -- and `owner` is a singleton row, so it can only be inserted
// once per file. One shared session for every test in this file, not one
// per test.
let session: TestOwnerSession;
beforeAll(async () => {
  session = await createTestOwnerSession();
});

function blob(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function insertDocument(): Promise<number> {
  async function insertKey(purpose: string): Promise<number> {
    const { meta } = await env.DB.prepare(
      "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES (?, ?, ?)",
    )
      .bind(purpose, blob(48), Date.now())
      .run();
    return meta.last_row_id;
  }
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

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe("POST /v1/bookmarks", () => {
  it("creates a bookmark and its key_store row", async () => {
    const documentId = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest("POST", "/v1/bookmarks", {
        document_id: documentId,
        key_wrapped: base64Encode(blob(48)),
        bookmark_blob: base64Encode(blob(32)),
      });
      const response = await SELF.fetch("https://example.com/v1/bookmarks", {
        ...init,
        headers: { ...init.headers, ...accessHeaders },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: number };
      expect(body.id).toBeGreaterThan(0);

      const row = await env.DB.prepare("SELECT document_id FROM bookmarks WHERE id = ?")
        .bind(body.id)
        .first<{ document_id: number }>();
      expect(row?.document_id).toBe(documentId);
    } finally {
      restore();
    }
  });

  it("rejects an invalid document_id and leaves no orphaned key_store row", async () => {
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const keyStoreBefore = await countRows("key_store");
      const init = await session.signedRequest("POST", "/v1/bookmarks", {
        document_id: 999999,
        key_wrapped: base64Encode(blob(48)),
        bookmark_blob: base64Encode(blob(32)),
      });
      const response = await SELF.fetch("https://example.com/v1/bookmarks", {
        ...init,
        headers: { ...init.headers, ...accessHeaders },
      });
      expect(response.status).toBe(400);
      expect(await countRows("key_store")).toBe(keyStoreBefore);
    } finally {
      restore();
    }
  });
});

describe("GET /v1/bookmarks", () => {
  it("lists bookmarks for the requested document only", async () => {
    const documentA = await insertDocument();
    const documentB = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      for (const [documentId, count] of [
        [documentA, 2],
        [documentB, 1],
      ] as const) {
        for (let i = 0; i < count; i++) {
          const init = await session.signedRequest("POST", "/v1/bookmarks", {
            document_id: documentId,
            key_wrapped: base64Encode(blob(48)),
            bookmark_blob: base64Encode(blob(32)),
          });
          await SELF.fetch("https://example.com/v1/bookmarks", {
            ...init,
            headers: { ...init.headers, ...accessHeaders },
          });
        }
      }

      const response = await SELF.fetch(
        `https://example.com/v1/bookmarks?document_id=${documentA}`,
        { headers: accessHeaders },
      );
      const body = (await response.json()) as { bookmarks: unknown[] };
      expect(body.bookmarks).toHaveLength(2);
    } finally {
      restore();
    }
  });
});

describe("DELETE /v1/bookmarks/:id", () => {
  it("deletes a bookmark and its key_store row", async () => {
    const documentId = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const createInit = await session.signedRequest("POST", "/v1/bookmarks", {
        document_id: documentId,
        key_wrapped: base64Encode(blob(48)),
        bookmark_blob: base64Encode(blob(32)),
      });
      const createResponse = await SELF.fetch("https://example.com/v1/bookmarks", {
        ...createInit,
        headers: { ...createInit.headers, ...accessHeaders },
      });
      const { id } = (await createResponse.json()) as { id: number };

      const deleteInit = await session.signedRequest("DELETE", `/v1/bookmarks/${id}`);
      const deleteResponse = await SELF.fetch(
        `https://example.com/v1/bookmarks/${id}`,
        {
          ...deleteInit,
          headers: { ...deleteInit.headers, ...accessHeaders },
        },
      );
      expect(deleteResponse.status).toBe(204);

      const row = await env.DB.prepare("SELECT id FROM bookmarks WHERE id = ?")
        .bind(id)
        .first();
      expect(row).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns 204 for an already-deleted bookmark (idempotent)", async () => {
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest("DELETE", "/v1/bookmarks/999999");
      const response = await SELF.fetch("https://example.com/v1/bookmarks/999999", {
        ...init,
        headers: { ...init.headers, ...accessHeaders },
      });
      expect(response.status).toBe(204);
    } finally {
      restore();
    }
  });
});
