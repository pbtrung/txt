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

async function insertDocumentWithoutAccess(): Promise<{
  id: number;
  contentBlob: Uint8Array;
  contentKeyWrapped: Uint8Array;
}> {
  const contentKey = await insertKey("content_key");
  const contentBlob = blob(32);
  const { meta } = await env.DB.prepare(
    "INSERT INTO documents (created_at, content_key_id, content_blob) VALUES (?, ?, ?)",
  )
    .bind(Date.now(), contentKey.id, contentBlob)
    .run();
  return { id: meta.last_row_id, contentBlob, contentKeyWrapped: contentKey.wrapped };
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

describe("GET /v1/documents/recent-access", () => {
  it("returns an empty list for a library with zero accessed documents", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(
        "https://example.com/v1/documents/recent-access",
        { headers },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ documents: [] });
    } finally {
      restore();
    }
  });

  it("returns the correct joined row for a library with one accessed document", async () => {
    const doc = await insertDocument();
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(
        "https://example.com/v1/documents/recent-access",
        { headers },
      );
      const body = (await response.json()) as { documents: Record<string, unknown>[] };
      const row = body.documents.find((r) => r.id === doc.id);
      expect(row?.content_blob).toBeUndefined();
      expect(row?.content_key_wrapped).toBeUndefined();
      expect(row?.access_blob).toBe(base64Encode(doc.accessBlob));
      expect(row?.access_key_wrapped).toBe(base64Encode(doc.accessKeyWrapped));
      expect(row?.access_version).toBe(0);
    } finally {
      restore();
    }
  });

  it("returns every accessed document's own access key, not cross-joined", async () => {
    const docs = await Promise.all([
      insertDocument(),
      insertDocument(),
      insertDocument(),
    ]);
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(
        "https://example.com/v1/documents/recent-access",
        { headers },
      );
      const body = (await response.json()) as { documents: Record<string, unknown>[] };
      // D1 storage carries over from the prior test in this file (only
      // reset between files), so this asserts against the actual current
      // accessed total rather than a count that assumes a clean slate.
      const { n: accessedDocuments } = (await env.DB.prepare(
        "SELECT count(*) AS n FROM documents WHERE access_key_id IS NOT NULL",
      ).first<{ n: number }>())!;
      expect(body.documents).toHaveLength(accessedDocuments);
      for (const doc of docs) {
        const row = body.documents.find((r) => r.id === doc.id);
        expect(row?.access_key_wrapped).toBe(base64Encode(doc.accessKeyWrapped));
      }
    } finally {
      restore();
    }
  });

  it("excludes a never-opened document entirely", async () => {
    const doc = await insertDocumentWithoutAccess();
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(
        "https://example.com/v1/documents/recent-access",
        { headers },
      );
      const body = (await response.json()) as { documents: Record<string, unknown>[] };
      expect(body.documents.find((r) => r.id === doc.id)).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("GET /v1/documents/:id", () => {
  it("returns the same shape as the library list, for one document only", async () => {
    const [docA, docB] = await Promise.all([insertDocument(), insertDocument()]);
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(`https://example.com/v1/documents/${docA.id}`, {
        headers,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.id).toBe(docA.id);
      expect(body.access_blob).toBe(base64Encode(docA.accessBlob));
      expect(body.access_key_wrapped).toBe(base64Encode(docA.accessKeyWrapped));
      expect(body.access_blob).not.toBe(base64Encode(docB.accessBlob));
    } finally {
      restore();
    }
  });

  it("returns 404 for a document that doesn't exist", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/documents/999999", {
        headers,
      });
      expect(response.status).toBe(404);
    } finally {
      restore();
    }
  });

  it("returns null access_blob/access_key_wrapped for a never-opened document", async () => {
    const doc = await insertDocumentWithoutAccess();
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(`https://example.com/v1/documents/${doc.id}`, {
        headers,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.access_blob).toBeNull();
      expect(body.access_key_wrapped).toBeNull();
      expect(body.access_version).toBe(0);
    } finally {
      restore();
    }
  });

  it("rejects a non-integer id with 400", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(
        "https://example.com/v1/documents/not-a-number",
        {
          headers,
        },
      );
      expect(response.status).toBe(400);
    } finally {
      restore();
    }
  });
});

describe("GET /v1/documents/:id/content", () => {
  it("returns the document's content key and blob, not any other document's", async () => {
    const [docA, docB] = await Promise.all([insertDocument(), insertDocument()]);
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${docA.id}/content`,
        { headers },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.content_blob).toBe(base64Encode(docA.contentBlob));
      expect(body.content_key_wrapped).toBe(base64Encode(docA.contentKeyWrapped));
      expect(body.content_blob).not.toBe(base64Encode(docB.contentBlob));
    } finally {
      restore();
    }
  });

  it("returns 404 for a document that doesn't exist", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(
        "https://example.com/v1/documents/999999/content",
        { headers },
      );
      expect(response.status).toBe(404);
    } finally {
      restore();
    }
  });

  it("rejects a non-integer id with 400", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch(
        "https://example.com/v1/documents/not-a-number/content",
        { headers },
      );
      expect(response.status).toBe(400);
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

  it("rejects malformed base64 user_handle with 400 instead of crashing (requireProof.ts, shared by every proof-requiring route)", async () => {
    const doc = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        { access_blob: base64Encode(blob(32)), access_version: 0 },
      );
      const badBody = JSON.stringify({
        ...JSON.parse(new TextDecoder().decode(init.body as Uint8Array)),
        user_handle: "not valid base64!!",
      });
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        {
          ...init,
          headers: { ...init.headers, ...accessHeaders },
          body: badBody,
        },
      );
      expect(response.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("rejects malformed base64 in access_blob with 400 instead of crashing", async () => {
    const doc = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        { access_blob: "not valid base64!!", access_version: 0 },
      );
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        { ...init, headers: { ...init.headers, ...accessHeaders } },
      );
      expect(response.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("rejects a non-integer access_version with 400", async () => {
    const doc = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        { access_blob: base64Encode(blob(32)), access_version: 0.5 },
      );
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        { ...init, headers: { ...init.headers, ...accessHeaders } },
      );
      expect(response.status).toBe(400);
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

  it("mints an access key on a document's first-ever write", async () => {
    const doc = await insertDocumentWithoutAccess();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const accessKeyWrapped = blob(48);
      const accessBlob = blob(32);
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        {
          access_blob: base64Encode(accessBlob),
          access_version: 0,
          access_key_wrapped: base64Encode(accessKeyWrapped),
        },
      );
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        { ...init, headers: { ...init.headers, ...accessHeaders } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ access_version: 1 });

      const row = await env.DB.prepare(
        `SELECT d.access_blob, k.wrapped_key AS access_key_wrapped, k.purpose
         FROM documents d JOIN key_store k ON k.id = d.access_key_id
         WHERE d.id = ?`,
      )
        .bind(doc.id)
        .first<{
          access_blob: ArrayBuffer;
          access_key_wrapped: ArrayBuffer;
          purpose: string;
        }>();
      expect(base64Decode(base64Encode(row!.access_blob))).toEqual(accessBlob);
      expect(base64Decode(base64Encode(row!.access_key_wrapped))).toEqual(
        accessKeyWrapped,
      );
      expect(row!.purpose).toBe("access_key");
    } finally {
      restore();
    }
  });

  it("cleans up the minted key_store row when a first-ever write conflicts", async () => {
    const doc = await insertDocumentWithoutAccess();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const keyStoreBefore = (await env.DB.prepare(
        "SELECT count(*) AS n FROM key_store",
      ).first<{ n: number }>())!.n;
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        {
          access_blob: base64Encode(blob(32)),
          access_version: 5, // wrong -- the document is still at 0
          access_key_wrapped: base64Encode(blob(48)),
        },
      );
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        { ...init, headers: { ...init.headers, ...accessHeaders } },
      );
      expect(response.status).toBe(412);

      const keyStoreAfter = (await env.DB.prepare(
        "SELECT count(*) AS n FROM key_store",
      ).first<{ n: number }>())!.n;
      expect(keyStoreAfter).toBe(keyStoreBefore);
    } finally {
      restore();
    }
  });

  it("clears access_blob/access_key_id back to null and deletes the old key_store row", async () => {
    const doc = await insertDocument();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const keyStoreBefore = (await env.DB.prepare(
        "SELECT count(*) AS n FROM key_store",
      ).first<{ n: number }>())!.n;
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        { access_version: 0 },
      );
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        { ...init, headers: { ...init.headers, ...accessHeaders } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ access_version: 1 });

      const row = await env.DB.prepare(
        "SELECT access_blob, access_key_id FROM documents WHERE id = ?",
      )
        .bind(doc.id)
        .first<{ access_blob: ArrayBuffer | null; access_key_id: number | null }>();
      expect(row?.access_blob).toBeNull();
      expect(row?.access_key_id).toBeNull();

      const keyStoreAfter = (await env.DB.prepare(
        "SELECT count(*) AS n FROM key_store",
      ).first<{ n: number }>())!.n;
      expect(keyStoreAfter).toBe(keyStoreBefore - 1);
    } finally {
      restore();
    }
  });

  it("clearing an already-unaccessed document is a no-op that still succeeds", async () => {
    const doc = await insertDocumentWithoutAccess();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        { access_version: 0 },
      );
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        { ...init, headers: { ...init.headers, ...accessHeaders } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ access_version: 1 });
    } finally {
      restore();
    }
  });

  it("rejects malformed base64 in access_key_wrapped with 400", async () => {
    const doc = await insertDocumentWithoutAccess();
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest(
        "PATCH",
        `/v1/documents/${doc.id}/access`,
        {
          access_blob: base64Encode(blob(32)),
          access_version: 0,
          access_key_wrapped: "not valid base64!!",
        },
      );
      const response = await SELF.fetch(
        `https://example.com/v1/documents/${doc.id}/access`,
        { ...init, headers: { ...init.headers, ...accessHeaders } },
      );
      expect(response.status).toBe(400);
    } finally {
      restore();
    }
  });
});
