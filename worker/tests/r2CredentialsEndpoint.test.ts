// Milestone 6 (docs/milestones.md): POST /v1/r2-credentials, through the
// real fetch() handler. The actual Cloudflare temp-access-credentials API
// call is mocked here (there's no live Cloudflare account/bucket in this
// test environment) -- what's under test is the Worker's own request
// shape (permission/prefixes/bucket per credential) and response mapping,
// gated by ticket + proof. Milestone 6's "actually attempt a PUT against
// catalog/* using the read-only credential" test needs a live deployment
// and hasn't been run -- see docs/milestones.md's Milestone 6 status note.
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestOwnerSession } from "./testOwnerSession";
import type { TestOwnerSession } from "./testOwnerSession";
import {
  mockAccessCertsEndpoint,
  signTestAccessToken,
  testJwks,
} from "./testAccessToken";

// D1 storage isn't reset between `it()` blocks within a file (only between
// files) -- and `owner` is a singleton row, so it can only be inserted
// once per file. One shared session for every test in this file, not one
// per test.
let session: TestOwnerSession;
beforeAll(async () => {
  session = await createTestOwnerSession();
});

interface CapturedRequest {
  permission: string;
  prefixes: string[];
  bucket: string;
  parentAccessKeyId: string;
}

function mockCloudflareApi(captured: CapturedRequest[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/cdn-cgi/access/certs")) {
      return Response.json(await testJwks());
    }
    if (url.includes("/r2/temp-access-credentials")) {
      const body = JSON.parse(String(init?.body)) as CapturedRequest;
      captured.push(body);
      return Response.json({
        success: true,
        result: {
          accessKeyId: `key-for-${body.permission}`,
          secretAccessKey: "secret",
          sessionToken: "token",
        },
      });
    }
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
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

describe("POST /v1/r2-credentials", () => {
  it("rejects the request with no ticket/proof", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/r2-credentials", {
        method: "POST",
        headers,
        body: JSON.stringify({ user_handle: "x", db_prefix: "y" }),
      });
      expect(response.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("mints a read-write credential for documents/shared and a read-only one for catalog", async () => {
    const captured: CapturedRequest[] = [];
    const restore = mockCloudflareApi(captured);
    try {
      const token = await signTestAccessToken({
        email: env.OWNER_EMAIL,
        aud: [env.CF_ACCESS_AUD],
        iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const init = await session.signedRequest("POST", "/v1/r2-credentials");
      const response = await SELF.fetch("https://example.com/v1/r2-credentials", {
        ...init,
        headers: { ...init.headers, "Cf-Access-Jwt-Assertion": token },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        bucket: string;
        documents: { access_key_id: string };
        catalog: { access_key_id: string };
      };
      expect(body.bucket).toBe(env.BUCKET_NAME);
      expect(body.documents.access_key_id).toBe("key-for-object-read-write");
      expect(body.catalog.access_key_id).toBe("key-for-object-read-only");

      expect(captured).toHaveLength(2);
      const documentsRequest = captured.find(
        (c) => c.permission === "object-read-write",
      )!;
      expect(documentsRequest.prefixes).toEqual([
        `${session.dbPrefix}/documents/`,
        `${session.dbPrefix}/shared/`,
      ]);
      const catalogRequest = captured.find((c) => c.permission === "object-read-only")!;
      expect(catalogRequest.prefixes).toEqual([`${session.dbPrefix}/catalog/`]);
    } finally {
      restore();
    }
  });

  it("returns 502 when the Cloudflare API call fails", async () => {
    const restoreAccess = mockAccessCertsEndpoint();
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/cdn-cgi/access/certs")) {
        return Response.json(await testJwks());
      }
      if (url.includes("/r2/temp-access-credentials")) {
        return new Response("nope", { status: 500 });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      const token = await signTestAccessToken({
        email: env.OWNER_EMAIL,
        aud: [env.CF_ACCESS_AUD],
        iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const init = await session.signedRequest("POST", "/v1/r2-credentials");
      const response = await SELF.fetch("https://example.com/v1/r2-credentials", {
        ...init,
        headers: { ...init.headers, "Cf-Access-Jwt-Assertion": token },
      });
      expect(response.status).toBe(502);
    } finally {
      globalThis.fetch = original;
      restoreAccess();
    }
  });
});
