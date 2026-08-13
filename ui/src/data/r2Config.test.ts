import { describe, expect, it } from "vitest";

import { parseAdminR2WriteCreds, parseR2Config } from "./r2Config";

describe("parseR2Config", () => {
  it("parses connection info only, ignoring any key fields the stored JSON still carries", () => {
    const result = parseR2Config({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
      // The CLI's own r2_config still writes these (txt/creds.ts). This
      // parser itself always ignores them -- an admin session gets them via
      // the separate parseAdminR2WriteCreds below instead, never folded
      // into this type, so every other caller of R2Config keeps its "no
      // keys in here" assumption intact.
      read_only_access_key_id: "ro-id",
      read_only_secret_access_key: "ro-secret",
      read_write_access_key_id: "rw-id",
      read_write_secret_access_key: "rw-secret",
    });
    expect(result).toEqual({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
    });
  });

  it("rejects a missing required field", () => {
    expect(() =>
      parseR2Config({
        endpoint: "https://x",
        region: "auto",
      }),
    ).toThrow("bucket is required");
  });

  it("rejects a non-object", () => {
    expect(() => parseR2Config(null)).toThrow();
    expect(() => parseR2Config("nope")).toThrow();
  });
});

describe("parseAdminR2WriteCreds", () => {
  it("parses the admin's real read-write key pair when present", () => {
    const result = parseAdminR2WriteCreds({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
      read_write_access_key_id: "rw-id",
      read_write_secret_access_key: "rw-secret",
    });
    expect(result).toEqual({
      accessKeyId: "rw-id",
      secretAccessKey: "rw-secret",
    });
  });

  it("returns null for a user-role row's r2_config, which never has these fields", () => {
    const result = parseAdminR2WriteCreds({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
    });
    expect(result).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(() => parseAdminR2WriteCreds(null)).toThrow();
  });
});
