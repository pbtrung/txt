import { describe, expect, it } from "vitest";

import { computeR2Prefix, generateRawPath } from "./pagePointer";

const CROCKFORD_BASE32_RE = /^[0-9abcdefghjkmnpqrstvwxyz]+$/;

describe("computeR2Prefix", () => {
  it("is deterministic for the same auth.id", () => {
    expect(computeR2Prefix("auth-123")).toBe(computeR2Prefix("auth-123"));
  });

  it("differs across auth.ids", () => {
    expect(computeR2Prefix("auth-123")).not.toBe(computeR2Prefix("auth-456"));
  });

  it("is lowercase Crockford base32", () => {
    expect(computeR2Prefix("auth-123")).toMatch(CROCKFORD_BASE32_RE);
  });
});

describe("generateRawPath", () => {
  it("prefixes the raw path with r2Prefix", () => {
    const prefix = computeR2Prefix("auth-123");
    expect(generateRawPath(prefix)).toMatch(new RegExp(`^${prefix}/`));
  });

  it("generates a fresh random suffix on every call", () => {
    const prefix = computeR2Prefix("auth-123");
    const a = generateRawPath(prefix);
    const b = generateRawPath(prefix);
    expect(a).not.toBe(b);
  });

  it("the suffix is lowercase Crockford base32", () => {
    const prefix = computeR2Prefix("auth-123");
    const suffix = generateRawPath(prefix).slice(prefix.length + 1);
    expect(suffix).toMatch(CROCKFORD_BASE32_RE);
  });
});
