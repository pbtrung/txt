import { describe, expect, it } from "vitest";

import { CredsError, parseCreds } from "./creds";
import { bytesToBase64 } from "../crypto/bytes";

function validCreds(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rqlite_url: "https://rqlite.example.com:4001",
    api_key: "some-api-key",
    user_root_key: bytesToBase64(new Uint8Array(256)),
    ...overrides,
  };
}

describe("parseCreds", () => {
  it("parses a valid creds file", () => {
    const creds = parseCreds(validCreds());
    expect(creds.rqliteUrl).toBe("https://rqlite.example.com:4001");
    expect(creds.apiKey).toBe("some-api-key");
    expect(creds.userRootKey.length).toBe(256);
    expect(creds.displayName).toBeUndefined();
  });

  it("parses an optional display_name when present", () => {
    const creds = parseCreds(validCreds({ display_name: "Trung" }));
    expect(creds.displayName).toBe("Trung");
  });

  it("treats a non-string or empty display_name as absent, not an error", () => {
    expect(parseCreds(validCreds({ display_name: "" })).displayName).toBeUndefined();
    expect(parseCreds(validCreds({ display_name: 42 })).displayName).toBeUndefined();
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
});
