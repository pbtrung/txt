import { describe, expect, it } from "vitest";

import { CredsError, parseCreds } from "./creds";
import { bytesToBase64 } from "../crypto/bytes";

function validR2Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: "https://example.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "txt-parts",
    read_only_access_key_id: "ro-key-id",
    read_only_secret_access_key: "ro-secret",
    ...overrides,
  };
}

function validCreds(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rqlite_url: "https://rqlite.example.com:4001",
    api_key: "some-api-key",
    user_root_key: bytesToBase64(new Uint8Array(256)),
    r2_config: validR2Config(),
    ...overrides,
  };
}

describe("parseCreds", () => {
  it("parses a valid creds file", () => {
    const creds = parseCreds(validCreds());
    expect(creds.rqliteUrl).toBe("https://rqlite.example.com:4001");
    expect(creds.apiKey).toBe("some-api-key");
    expect(creds.userRootKey.length).toBe(256);
    expect(creds.r2Config.bucket).toBe("txt-parts");
  });

  it("rejects a non-object", () => {
    expect(() => parseCreds("not an object")).toThrow(CredsError);
    expect(() => parseCreds(null)).toThrow(CredsError);
  });

  it("rejects a missing required string field", () => {
    const creds = validCreds();
    delete creds.rqlite_url;
    expect(() => parseCreds(creds)).toThrow("rqlite_url is required");
  });

  it("rejects a user_root_key shorter than the minimum length", () => {
    const creds = validCreds({ user_root_key: bytesToBase64(new Uint8Array(64)) });
    expect(() => parseCreds(creds)).toThrow("user_root_key too short");
  });

  it("rejects invalid base64", () => {
    const creds = validCreds({ user_root_key: "not-valid-base64!!!" });
    expect(() => parseCreds(creds)).toThrow(CredsError);
  });

  it("rejects a missing/invalid r2_config", () => {
    const creds = validCreds({ r2_config: {} });
    expect(() => parseCreds(creds)).toThrow(CredsError);
  });
});
