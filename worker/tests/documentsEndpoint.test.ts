// Milestone 5 (docs/milestones.md): GET /v1/documents (the N+1-avoidance
// join) and PATCH /v1/documents/:id/access (the access_version optimistic
// concurrency path), through the real fetch() handler.
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { base64Decode, base64Encode } from "../base64";
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
  contentBlob: Uint8Array;
  contentKeyWrapped: Uint8Array;
  accessBlob: Uint8Array;
  accessKeyWrapped: Uint8Array;
}> {
  const contentKey = await insertKey("content_key");
  const accessKey = await insertKey("access_key");
  const contentBlob = blob(32);
  const accessBlob = blob(32);
  const { meta } = await env.DB.prepare(
    `INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id, access_blob)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(Date.now(), contentKey.id, contentBlob, accessKey.id, accessBlob)
    .run();
  return {
    id: meta.last_row_id,
    contentBlob,
    contentKeyWrapped: contentKey.wrapped,
    accessBlob,
    accessKeyWrapped: accessKey.wrapped,
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

describe("GET /v1/documents", () => {
  it("returns an empty list for a library with zero documents", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/documents", {
        headers,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ documents: [] });
    } finally {
      restore();
    }
  });

  it("returns the correct joined row for a library with one document", async () => {
    const doc = await insertDocument();
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/documents", {
        headers,
      });
      const body = (await response.json()) as { documents: Record<string, unknown>[] };
      expect(body.documents).toHaveLength(1);
      const row = body.documents[0];
      expect(row.id).toBe(doc.id);
      expect(row.content_blob).toBe(base64Encode(doc.contentBlob));
      expect(row.content_key_wrapped).toBe(base64Encode(doc.contentKeyWrapped));
      expect(row.access_blob).toBe(base64Encode(doc.accessBlob));
      expect(row.access_key_wrapped).toBe(base64Encode(doc.accessKeyWrapped));
      expect(row.access_version).toBe(0);
    } finally {
      restore();
    }
  });

  it("returns every document's own keys, not cross-joined, for a library with many documents", async () => {
    const docs = await Promise.all([
      insertDocument(),
      insertDocument(),
      insertDocument(),
    ]);
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/documents", {
        headers,
      });
      const body = (await response.json()) as { documents: Record<string, unknown>[] };
      // D1 storage carries over from the prior test in this file (only
      // reset between files), so this asserts against the actual current
      // total rather than a count that assumes a clean slate.
      const { n: totalDocuments } = (await env.DB.prepare(
        "SELECT count(*) AS n FROM documents",
      ).first<{ n: number }>())!;
      expect(body.documents).toHaveLength(totalDocuments);
      for (const doc of docs) {
        const row = body.documents.find((r) => r.id === doc.id);
        expect(row?.content_key_wrapped).toBe(base64Encode(doc.contentKeyWrapped));
        expect(row?.access_key_wrapped).toBe(base64Encode(doc.accessKeyWrapped));
      }
    } finally {
      restore();
    }
  });
});

describe("PATCH /v1/documents/:id/access", () => {
  it("updates access_blob and increments access_version", async () => {
    const doc = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const newBlob = blob(32);
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        { access_blob: base64Encode(newBlob), access_version: 0 },
      );
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        {
          ...init,
          headers: { ...init.headers, ...accessHeaders },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ access_version: 1 });

      const row = await env.DB.prepare(
        "SELECT access_blob, access_version FROM documents WHERE id = ?",
      )
        .bind(doc.id)
        .first<{ access_blob: ArrayBuffer; access_version: number }>();
      expect(base64Decode(base64Encode(row!.access_blob))).toEqual(newBlob);
      expect(row?.access_version).toBe(1);
    } finally {
      restore();
    }
  });

  it("returns 404 for a document that doesn't exist", async () => {
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest("PATCH", "/v1/documents/999999/access", {
        access_blob: base64Encode(blob(32)),
        access_version: 0,
      });
      const response = await SELF.fetch(
        "https://example.com/v1/documents/999999/access",
        {
          ...init,
          headers: { ...init.headers, ...accessHeaders },
        },
      );
      expect(response.status).toBe(404);
    } finally {
      restore();
    }
  });

  // The concurrency case docs/milestones.md's Milestone 5 calls out
  // specifically: two overlapping requests racing for the same stale
  // version, simulated for real rather than reasoned about on paper.
  it("lets exactly one of two concurrent updates against the same access_version win, the other gets 412", async () => {
    const doc = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const [initA, initB] = await Promise.all([
        session.signedRequest("PATCH", `/v1/documents/${doc.id}/access`, {
          access_blob: base64Encode(blob(32)),
          access_version: 0,
        }),
        session.signedRequest("PATCH", `/v1/documents/${doc.id}/access`, {
          access_blob: base64Encode(blob(32)),
          access_version: 0,
        }),
      ]);
      const [responseA, responseB] = await Promise.all([
        SELF.fetch(`https://example.com/v1/documents/${doc.id}/access`, {
          ...initA,
          headers: { ...initA.headers, ...accessHeaders },
        }),
        SELF.fetch(`https://example.com/v1/documents/${doc.id}/access`, {
          ...initB,
          headers: { ...initB.headers, ...accessHeaders },
        }),
      ]);
      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([200, 412]);

      const row = await env.DB.prepare(
        "SELECT access_version FROM documents WHERE id = ?",
      )
        .bind(doc.id)
        .first<{ access_version: number }>();
      expect(row?.access_version).toBe(1);
    } finally {
      restore();
    }
  });
});
