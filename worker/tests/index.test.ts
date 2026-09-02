// Milestone 0 (docs/milestones.md): confirm the Worker actually boots and
// routes correctly inside the real Workers runtime -- not just that the
// code compiles.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("routing", () => {
  it("serves /v1/health as JSON 200", async () => {
    const response = await SELF.fetch("https://example.com/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the built UI shell at /", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<html");
  });

  it("falls back to the SPA shell for an unknown non-API path", async () => {
    const response = await SELF.fetch("https://example.com/shared");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("returns 404 for an unknown /v1/* path", async () => {
    const response = await SELF.fetch("https://example.com/v1/nope");
    expect(response.status).toBe(404);
  });

  it("returns 405 for a wrong method on a known /v1/* path", async () => {
    const response = await SELF.fetch("https://example.com/v1/health", {
      method: "POST",
    });
    expect(response.status).toBe(405);
  });
});
