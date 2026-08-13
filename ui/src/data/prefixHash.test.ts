import { describe, expect, it } from "vitest";

import { computePrefixHash } from "./prefixHash";

describe("computePrefixHash", () => {
  it("stores the raw SHA-256 digest as padded Base64, same as txt/prefixHash.ts", async () => {
    // Cross-checked against tests/updateDbPrefixHash.test.ts's own
    // computePrefixHash("prefix-1") expectation -- both sides must agree on
    // the exact same digest for the same input.
    expect(await computePrefixHash("prefix-1")).toBe(
      "RPzASQKOgy/Q3ZB41hIoIKBjUR+hXpNvZGWhLfCAtLo=",
    );
  });
});
