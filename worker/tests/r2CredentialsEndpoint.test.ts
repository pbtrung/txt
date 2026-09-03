// POST /v1/r2-credentials, through the real fetch() handler. Credentials
// are minted entirely locally (signed
// JWTs, docs/storage_layout.md §"Credentials") -- no network call to
// mock, so what's under test is the Worker's own claim shape
// (bucket/scope/paths per credential, decoded and verified against the
// test parent secret key) and response mapping, gated by ticket + proof.
import { jwtVerify } from "jose";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handlePostR2Credentials } from "../r2CredentialsEndpoint";
import type { ProofContext } from "../requireProof";
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

interface Claims {
  bucket: string;
  scope: string;
  paths?: { prefixPaths: string[]; objectPaths: string[] };
  sub: string;
  iss: string;
  aud: string;
}

async function decodeSessionToken(sessionToken: string): Promise<Claims> {
  const jwt = atob(sessionToken).replace(/^jwt\//, "");
  const { payload } = await jwtVerify(
    jwt,
    new TextEncoder().encode(env.R2_PARENT_SECRET_ACCESS_KEY),
  );
  return payload as unknown as Claims;
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
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest("POST", "/v1/r2-credentials");
      const response = await SELF.fetch("https://example.com/v1/r2-credentials", {
        ...init,
        headers: { ...init.headers, ...accessHeaders },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        bucket: string;
        documents: { access_key_id: string; session_token: string };
        catalog: { access_key_id: string; session_token: string };
      };
      expect(body.bucket).toBe(env.BUCKET_NAME);
      expect(body.documents.access_key_id).toBe(env.R2_PARENT_ACCESS_KEY_ID);
      expect(body.catalog.access_key_id).toBe(env.R2_PARENT_ACCESS_KEY_ID);

      const documentsClaims = await decodeSessionToken(body.documents.session_token);
      expect(documentsClaims.bucket).toBe(env.BUCKET_NAME);
      expect(documentsClaims.scope).toBe("object-read-write");
      expect(documentsClaims.paths?.prefixPaths).toEqual([
        `${session.dbPrefix}/documents/`,
        `${session.dbPrefix}/shared/`,
      ]);
      expect(documentsClaims.sub).toBe(env.CF_ACCOUNT_ID);
      expect(documentsClaims.iss).toBe(env.R2_PARENT_ACCESS_KEY_ID);

      const catalogClaims = await decodeSessionToken(body.catalog.session_token);
      expect(catalogClaims.scope).toBe("object-read-only");
      expect(catalogClaims.paths?.prefixPaths).toEqual([
        `${session.dbPrefix}/catalog/`,
      ]);
    } finally {
      restore();
    }
  });

  it("derives the secret access key as the SHA-256 hex digest of the signed JWT", async () => {
    const { restore, headers: accessHeaders } = await accessSession();
    try {
      const init = await session.signedRequest("POST", "/v1/r2-credentials");
      const response = await SELF.fetch("https://example.com/v1/r2-credentials", {
        ...init,
        headers: { ...init.headers, ...accessHeaders },
      });
      const body = (await response.json()) as {
        documents: { secret_access_key: string; session_token: string };
      };
      const jwt = atob(body.documents.session_token).replace(/^jwt\//, "");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(jwt),
      );
      const expected = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(body.documents.secret_access_key).toBe(expected);
    } finally {
      restore();
    }
  });

  it("returns 500 when a required secret is missing, without minting anything", async () => {
    const proof: ProofContext = {
      bodyJson: {},
      userHandle: new Uint8Array(32),
      dbPrefix: session.dbPrefix,
    };
    const incompleteEnv = {
      ...env,
      R2_PARENT_SECRET_ACCESS_KEY: undefined,
    } as unknown as Env;

    const response = await handlePostR2Credentials(incompleteEnv, proof);

    expect(response.status).toBe(500);
  });
});
