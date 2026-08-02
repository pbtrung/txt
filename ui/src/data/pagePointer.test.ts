import { describe, expect, it } from "vitest";

import { computeR2Prefix, generateRawKey } from "./pagePointer";

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

describe("generateRawKey", () => {
  // No auth.id/prefix involved -- generateRawKey only ever produces the
  // random suffix that gets encrypted into $files' uploaded content; the
  // real R2 object address (`${computeR2Prefix(authId)}/${rawKey}`) is
  // assembled separately at the point of the actual GET/PUT.
  it("generates a fresh random key on every call", () => {
    const a = generateRawKey();
    const b = generateRawKey();
    expect(a).not.toBe(b);
  });

  it("is lowercase Crockford base32", () => {
    expect(generateRawKey()).toMatch(CROCKFORD_BASE32_RE);
  });
});
