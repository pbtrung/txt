import { describe, expect, it } from "vitest";

import { parseR2Config } from "./r2Config";

describe("parseR2Config", () => {
  it("parses connection info only, ignoring any key fields the stored JSON still carries", () => {
    const result = parseR2Config({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
      // The CLI's own r2_config still writes these (txt/creds.ts) -- this
      // account's browser session must never parse or use them, since all
      // R2 access here goes through worker/r2Creds.ts's temporary
      // credentials instead (see tempR2Creds.ts).
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
