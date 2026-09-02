// Milestones 0 and 3 (docs/milestones.md): confirm the Worker actually
// boots and routes correctly inside the real Workers runtime, and that
// Access gating is enforced for real by the actual fetch() handler -- not
// just that verifyAccessJwt() is correct in isolation (worker/tests/
// access.test.ts already covers that).
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mockAccessCertsEndpoint, signTestAccessToken } from "./testAccessToken";

function validTestClaims(): Record<string, unknown> {
  return {
    email: env.OWNER_EMAIL,
    aud: [env.CF_ACCESS_AUD],
    iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("static assets and public routes", () => {
  it("serves the built UI shell at / with no Access session", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<html");
  });

  it("falls back to the SPA shell for an unknown non-API path with no Access session", async () => {
    const response = await SELF.fetch("https://example.com/shared");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("reaches POST /v1/shared-url with no Access session (the one declared exception)", async () => {
    const response = await SELF.fetch("https://example.com/v1/shared-url", {
      method: "POST",
    });
    // 501 (not yet implemented, Milestone 7) proves the request reached the
    // handler at all -- the property under test is "not blocked by Access,"
    // not "fully implemented."
    expect(response.status).toBe(501);
  });
});

describe("Access-gated /v1/* routes", () => {
  it("rejects /v1/health with no Access session", async () => {
    const response = await SELF.fetch("https://example.com/v1/health");
    expect(response.status).toBe(401);
  });

  it("rejects /v1/health with a malformed Access header", async () => {
    const response = await SELF.fetch("https://example.com/v1/health", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-real-token" },
    });
    expect(response.status).toBe(401);
  });

  it("accepts /v1/health with a validly signed Access session for the owner", async () => {
    const restore = mockAccessCertsEndpoint();
    try {
      const token = await signTestAccessToken(validTestClaims());
      const response = await SELF.fetch("https://example.com/v1/health", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    } finally {
      restore();
    }
  });

  it("rejects /v1/health for a validly signed session that isn't the owner", async () => {
    const restore = mockAccessCertsEndpoint();
    try {
      const token = await signTestAccessToken({
        ...validTestClaims(),
        email: "not-the-owner@example.com",
      });
      const response = await SELF.fetch("https://example.com/v1/health", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      });
      expect(response.status).toBe(401);
    } finally {
      restore();
    }
  });

  it("returns 404 for an unknown /v1/* path regardless of Access session", async () => {
    const response = await SELF.fetch("https://example.com/v1/nope");
    // No route is declared for this path at all, so it 404s before Access
    // verification would even run -- also a non-200 that isn't a crash.
    expect(response.status).toBe(404);
  });

  it("returns 405 for a wrong method on a known /v1/* path with no Access session", async () => {
    const response = await SELF.fetch("https://example.com/v1/health", {
      method: "POST",
    });
    expect(response.status).toBe(405);
  });
});
