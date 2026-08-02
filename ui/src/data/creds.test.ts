import { describe, expect, it } from "vitest";

import { CredsError, parseCreds } from "./creds";
import { bytesToBase64 } from "../crypto/bytes";

function validCreds(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    firebase_email: "admin@example.com",
    firebase_password: "hunter2",
    firebase_api_key: "fake-api-key",
    firebase_auth_domain: "example.firebaseapp.com",
    firebase_project_id: "example",
    instant_app_id: "app-1",
    instant_client_name: "firebase",
    user_root_key: bytesToBase64(new Uint8Array(256)),
    ...overrides,
  };
}

describe("parseCreds", () => {
  it("parses a valid creds file", () => {
    const creds = parseCreds(validCreds());
    expect(creds.firebaseEmail).toBe("admin@example.com");
    expect(creds.firebasePassword).toBe("hunter2");
    expect(creds.firebaseApiKey).toBe("fake-api-key");
    expect(creds.firebaseAuthDomain).toBe("example.firebaseapp.com");
    expect(creds.firebaseProjectId).toBe("example");
    expect(creds.instantAppId).toBe("app-1");
    expect(creds.instantClientName).toBe("firebase");
    expect(creds.userRootKey.length).toBe(256);
    expect(creds.displayName).toBeUndefined();
  });

  it("parses an optional display_name when present", () => {
    const creds = parseCreds(validCreds({ display_name: "Trung" }));
    expect(creds.displayName).toBe("Trung");
  });

  it("treats a non-string or empty display_name as absent, not an error", () => {
    expect(
      parseCreds(validCreds({ display_name: "" })).displayName,
    ).toBeUndefined();
    expect(
      parseCreds(validCreds({ display_name: 42 })).displayName,
    ).toBeUndefined();
  });

  it("ignores CLI-only fields (instant_admin_token, r2_config) rather than erroring", () => {
    const creds = parseCreds(
      validCreds({
        instant_admin_token: "unused-here",
        r2_config: { endpoint: "unused-here" },
      }),
    );
    expect(creds.instantAppId).toBe("app-1");
  });

  it("rejects a non-object", () => {
    expect(() => parseCreds("not an object")).toThrow(CredsError);
    expect(() => parseCreds(null)).toThrow(CredsError);
  });

  it("rejects a missing required string field", () => {
    const creds = validCreds();
    delete creds.firebase_email;
    expect(() => parseCreds(creds)).toThrow("firebase_email is required");
  });

  it("rejects a user_root_key shorter than the minimum length", () => {
    const creds = validCreds({
      user_root_key: bytesToBase64(new Uint8Array(64)),
    });
    expect(() => parseCreds(creds)).toThrow("user_root_key too short");
  });

  it("rejects invalid base64", () => {
    const creds = validCreds({ user_root_key: "not-valid-base64!!!" });
    expect(() => parseCreds(creds)).toThrow(CredsError);
  });
});
