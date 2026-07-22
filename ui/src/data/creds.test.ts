import { describe, expect, it } from "vitest";

import { CredsError, parseCreds } from "./creds";
import { bytesToBase64 } from "../crypto/bytes";

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turso_database_url: "libsql://example.turso.io",
    turso_auth_token: "token",
    username: "alice",
    username_lookup_key: bytesToBase64(new Uint8Array(32)),
    password: "hunter2",
    display_name: "Alice",
    user_root_key: bytesToBase64(new Uint8Array(256)),
    asset_sign_key: bytesToBase64(new Uint8Array(64)),
    asset_hashes: bytesToBase64(new Uint8Array(192)),
    ...overrides,
  };
}

describe("parseCreds", () => {
  it("parses a valid config", () => {
    const creds = parseCreds(validConfig());
    expect(creds.username).toBe("alice");
    expect(creds.displayName).toBe("Alice");
    expect(creds.usernameLookupKey.length).toBe(32);
    expect(creds.userRootKey.length).toBe(256);
    expect(creds.assetSignKey.length).toBe(64);
    expect(creds.assetHashes.length).toBe(192);
  });

  it("rejects a non-object", () => {
    expect(() => parseCreds("not an object")).toThrow(CredsError);
    expect(() => parseCreds(null)).toThrow(CredsError);
  });

  it("rejects a missing required string field", () => {
    const config = validConfig();
    delete config.username;
    expect(() => parseCreds(config)).toThrow("username is required");
  });

  it("rejects a username_lookup_key shorter than the minimum length", () => {
    const config = validConfig({ username_lookup_key: bytesToBase64(new Uint8Array(16)) });
    expect(() => parseCreds(config)).toThrow("username_lookup_key too short");
  });

  it("rejects a user_root_key shorter than the minimum length", () => {
    const config = validConfig({ user_root_key: bytesToBase64(new Uint8Array(64)) });
    expect(() => parseCreds(config)).toThrow("user_root_key too short");
  });

  it("rejects invalid base64", () => {
    const config = validConfig({ user_root_key: "not-valid-base64!!!" });
    expect(() => parseCreds(config)).toThrow(CredsError);
  });

  it("rejects an asset_sign_key that isn't exactly 64 bytes", () => {
    const config = validConfig({ asset_sign_key: bytesToBase64(new Uint8Array(32)) });
    expect(() => parseCreds(config)).toThrow("asset_sign_key must be 64 bytes");
  });

  it("rejects an asset_hashes that isn't exactly 192 bytes", () => {
    const config = validConfig({ asset_hashes: bytesToBase64(new Uint8Array(64)) });
    expect(() => parseCreds(config)).toThrow("asset_hashes must be 192 bytes");
  });
});
