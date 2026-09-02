// docs/data_model.md §2.1: GET /v1/catalog, the singleton catalog pointer
// row, through the real fetch() handler.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64Encode } from "../base64";
import { mockAccessCertsEndpoint, signTestAccessToken } from "./testAccessToken";

function blob(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
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

describe("GET /v1/catalog", () => {
  it("returns null when no catalog row has been provisioned yet", async () => {
    const { restore, headers } = await accessSession();
    try {
      const response = await SELF.fetch("https://example.com/v1/catalog", {
        headers,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ catalog: null });
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
      const response = await SELF.fetch("https://example.com/v1/catalog", {
        headers,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        catalog: {
          key_wrapped: base64Encode(wrappedKey),
          catalog_blob: base64Encode(catalogBlob),
        },
      });
    } finally {
      restore();
    }
  });

  it("rejects a request with no Access session", async () => {
    const response = await SELF.fetch("https://example.com/v1/catalog");
    expect(response.status).toBe(401);
  });
});
