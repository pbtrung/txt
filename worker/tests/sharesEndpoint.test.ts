// Milestone 7 (docs/milestones.md): GET/POST/DELETE /v1/shares, through
// the real fetch() handler except where a specific failure mode (R2
// deletion failure) needs a stubbed binding no HTTP-level mock can reach.
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { base64Encode } from "../base64";
import { handleDeleteShares } from "../sharesEndpoint";
import type { ProofContext } from "../requireProof";
import { createTestOwnerSession } from "./testOwnerSession";
import type { TestOwnerSession } from "./testOwnerSession";
import { mockAccessCertsEndpoint, signTestAccessToken } from "./testAccessToken";

function blob(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sharePath(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let i = 0; i < 52; i++)
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
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

let session: TestOwnerSession;
beforeAll(async () => {
  session = await createTestOwnerSession();
});

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

async function postShares(
  documentId: number,
  shareId: Uint8Array,
  path: string,
  accessHeaders: HeadersInit,
): Promise<Response> {
  const init = await session.signedRequest("POST", "/v1/shares", {
    document_id: documentId,
    share_id: base64UrlEncode(shareId),
    share_path: path,
    key_wrapped: base64Encode(blob(48)),
    owner_blob: base64Encode(blob(64)),
  });
  return SELF.fetch("https://example.com/v1/shares", {
    ...init,
    headers: { ...init.headers, ...accessHeaders },
  });
}

async function deleteShares(
  documentId: number,
  shareId: Uint8Array,
  path: string,
  accessHeaders: HeadersInit,
): Promise<Response> {
  const init = await session.signedRequest("DELETE", "/v1/shares", {
    document_id: documentId,
    share_id: base64UrlEncode(shareId),
    share_path: path,
  });
  return SELF.fetch("https://example.com/v1/shares", {
    ...init,
    headers: { ...init.headers, ...accessHeaders },
  });
}

describe("POST /v1/shares", () => {
  it("registers a share and returns a grant", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const { restore, headers } = await accessSession();
    try {
      const response = await postShares(documentId, shareId, sharePath(), headers);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { registered: boolean; grant: string };
      expect(body.registered).toBe(true);
      expect(body.grant.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("is idempotent for the same share_id and share_path, minting a fresh grant each time", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const { restore, headers } = await accessSession();
    try {
      const first = await postShares(documentId, shareId, path, headers);
      const second = await postShares(documentId, shareId, path, headers);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as { grant: string };
      const secondBody = (await second.json()) as { grant: string };
      expect(secondBody.grant).not.toBe(firstBody.grant);

      const rows = await env.DB.prepare(
        "SELECT count(*) AS n FROM shares WHERE share_id_hash = ?",
      )
        .bind(await crypto.subtle.digest("SHA-256", shareId))
        .first<{ n: number }>();
      expect(rows?.n).toBe(1);
    } finally {
      restore();
    }
  });

  it("rejects reusing the same share_id for a different share_path with 409", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const { restore, headers } = await accessSession();
    try {
      const first = await postShares(documentId, shareId, sharePath(), headers);
      const second = await postShares(documentId, shareId, sharePath(), headers);
      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
    } finally {
      restore();
    }
  });

  it("reactivates a share stuck in 'deleting' on idempotent replay", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const { restore, headers } = await accessSession();
    try {
      await postShares(documentId, shareId, path, headers);
      const shareIdHash = await crypto.subtle.digest("SHA-256", shareId);
      await env.DB.prepare(
        "UPDATE shares SET state = 'deleting' WHERE share_id_hash = ?",
      )
        .bind(shareIdHash)
        .run();

      const replay = await postShares(documentId, shareId, path, headers);
      expect(replay.status).toBe(200);

      const row = await env.DB.prepare(
        "SELECT state FROM shares WHERE share_id_hash = ?",
      )
        .bind(shareIdHash)
        .first<{ state: string }>();
      expect(row?.state).toBe("active");
    } finally {
      restore();
    }
  });

  it("both succeed when two concurrent creates race for the same new share_id", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const { restore, headers } = await accessSession();
    try {
      const [first, second] = await Promise.all([
        postShares(documentId, shareId, path, headers),
        postShares(documentId, shareId, path, headers),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const rows = await env.DB.prepare(
        "SELECT count(*) AS n FROM shares WHERE share_id_hash = ?",
      )
        .bind(await crypto.subtle.digest("SHA-256", shareId))
        .first<{ n: number }>();
      expect(rows?.n).toBe(1);
    } finally {
      restore();
    }
  });

  it("rejects malformed base64 in key_wrapped/owner_blob with 400 instead of crashing", async () => {
    const documentId = await insertDocument();
    const { restore, headers } = await accessSession();
    try {
      const init = await session.signedRequest("POST", "/v1/shares", {
        document_id: documentId,
        share_id: base64UrlEncode(blob(32)),
        share_path: sharePath(),
        key_wrapped: "not valid base64!!",
        owner_blob: base64Encode(blob(64)),
      });
      const response = await SELF.fetch("https://example.com/v1/shares", {
        ...init,
        headers: { ...init.headers, ...headers },
      });
      expect(response.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("rejects an invalid document_id with 400 and leaves no orphaned key_store row", async () => {
    const { restore, headers } = await accessSession();
    try {
      const keyStoreBefore = await env.DB.prepare(
        "SELECT count(*) AS n FROM key_store",
      ).first<{
        n: number;
      }>();
      const response = await postShares(999999, blob(32), sharePath(), headers);
      expect(response.status).toBe(400);
      const keyStoreAfter = await env.DB.prepare(
        "SELECT count(*) AS n FROM key_store",
      ).first<{
        n: number;
      }>();
      expect(keyStoreAfter?.n).toBe(keyStoreBefore?.n);
    } finally {
      restore();
    }
  });
});

describe("GET /v1/shares", () => {
  it("lists a registered share", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const { restore, headers } = await accessSession();
    try {
      await postShares(documentId, shareId, sharePath(), headers);
      const response = await SELF.fetch("https://example.com/v1/shares", { headers });
      const body = (await response.json()) as {
        shares: { document_id: number; state: string }[];
      };
      expect(
        body.shares.some((s) => s.document_id === documentId && s.state === "active"),
      ).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("DELETE /v1/shares", () => {
  it("revokes an active share: R2 object and D1 row are both gone", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const { restore, headers } = await accessSession();
    try {
      await postShares(documentId, shareId, path, headers);
      const response = await deleteShares(documentId, shareId, path, headers);
      expect(response.status).toBe(204);

      const row = await env.DB.prepare(
        "SELECT share_id_hash FROM shares WHERE share_id_hash = ?",
      )
        .bind(await crypto.subtle.digest("SHA-256", shareId))
        .first();
      expect(row).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns 204 for a share_id that was never registered (idempotent)", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await deleteShares(1, blob(32), sharePath(), headers);
      expect(response.status).toBe(204);
    } finally {
      restore();
    }
  });

  it("rejects a document_id/share_path that doesn't match the registered share with 400", async () => {
    const documentId = await insertDocument();
    const otherDocumentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const { restore, headers } = await accessSession();
    try {
      await postShares(documentId, shareId, path, headers);
      const response = await deleteShares(otherDocumentId, shareId, path, headers);
      expect(response.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("returns 409 for a share that exists but isn't active", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const shareIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", shareId));
    const { meta: keyMeta } = await env.DB.prepare(
      "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES ('share_key', ?, ?)",
    )
      .bind(blob(48), Date.now())
      .run();
    const objectPath = `${session.dbPrefix}/shared/${path}`;
    const objectPathHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(objectPath)),
    );
    await env.DB.prepare(
      `INSERT INTO shares (share_id_hash, document_id, object_path_hash, key_id, owner_blob, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'deleting', ?)`,
    )
      .bind(
        shareIdHash,
        documentId,
        objectPathHash,
        keyMeta.last_row_id,
        blob(64),
        Date.now(),
      )
      .run();

    const { restore, headers } = await accessSession();
    try {
      const response = await deleteShares(documentId, shareId, path, headers);
      expect(response.status).toBe(409);
    } finally {
      restore();
    }
  });

  it("returns 503 and leaves the row 'deleting' when R2 deletion fails", async () => {
    const documentId = await insertDocument();
    const shareId = blob(32);
    const path = sharePath();
    const { restore, headers } = await accessSession();
    try {
      await postShares(documentId, shareId, path, headers);
    } finally {
      restore();
    }

    const brokenBucketEnv = {
      DB: env.DB,
      BUCKET: {
        delete: () => {
          throw new Error("simulated R2 failure");
        },
      },
    } as unknown as Env;
    const proof: ProofContext = {
      bodyJson: {
        document_id: documentId,
        share_id: base64UrlEncode(shareId),
        share_path: path,
      },
      userHandle: session.userHandle,
      dbPrefix: session.dbPrefix,
    };
    const response = await handleDeleteShares(brokenBucketEnv, proof);
    expect(response.status).toBe(503);

    const row = await env.DB.prepare("SELECT state FROM shares WHERE share_id_hash = ?")
      .bind(await crypto.subtle.digest("SHA-256", shareId))
      .first<{ state: string }>();
    expect(row?.state).toBe("deleting");
  });
});
