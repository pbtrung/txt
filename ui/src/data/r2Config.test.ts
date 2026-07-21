import { describe, expect, it } from "vitest";

import { parseR2Config } from "./r2Config";

describe("parseR2Config", () => {
  it("parses read-only-only config (the shape this UI's account should have)", () => {
    const result = parseR2Config({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
      read_only_access_key_id: "ro-id",
      read_only_secret_access_key: "ro-secret",
    });
    expect(result).toEqual({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
      readOnlyAccessKeyId: "ro-id",
      readOnlySecretAccessKey: "ro-secret",
    });
  });

  it("rejects a config carrying read_write_access_key_id (this UI is never an admin-role session)", () => {
    expect(() =>
      parseR2Config({
        endpoint: "https://acct.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "my-bucket",
        read_only_access_key_id: "ro-id",
        read_only_secret_access_key: "ro-secret",
        read_write_access_key_id: "rw-id",
      }),
    ).toThrow("must not include read_write keys");
  });

  it("rejects a config carrying read_write_secret_access_key", () => {
    expect(() =>
      parseR2Config({
        endpoint: "https://acct.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "my-bucket",
        read_only_access_key_id: "ro-id",
        read_only_secret_access_key: "ro-secret",
        read_write_secret_access_key: "rw-secret",
      }),
    ).toThrow("must not include read_write keys");
  });

  it("rejects a missing required field", () => {
    expect(() =>
      parseR2Config({ endpoint: "https://x", region: "auto", bucket: "b", read_only_access_key_id: "id" }),
    ).toThrow("read_only_secret_access_key is required");
  });

  it("rejects a non-object", () => {
    expect(() => parseR2Config(null)).toThrow();
    expect(() => parseR2Config("nope")).toThrow();
  });
});
