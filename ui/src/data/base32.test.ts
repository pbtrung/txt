import { describe, expect, it } from "vitest";

import { encode } from "./base32";

function bytesRange(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => i);
}

describe("encode", () => {
  it("matches txt/base32.py's encode() for 32 sequential bytes", () => {
    expect(encode(bytesRange(32))).toBe("000g40r40m30e209185gr38e1w8124gk2gahc5rr34d1p70x3rfg");
  });

  it("matches txt/base32.py's encode() for empty input", () => {
    expect(encode(new Uint8Array())).toBe("");
  });

  it("matches txt/base32.py's encode() for all-0xff bytes", () => {
    expect(encode(new Uint8Array(32).fill(0xff))).toBe(
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzg",
    );
  });

  it("matches txt/base32.py's encode() for all-zero bytes", () => {
    expect(encode(new Uint8Array(32))).toBe("0000000000000000000000000000000000000000000000000000");
  });

  it("matches txt/base32.py's encode() for a single byte", () => {
    expect(encode(Uint8Array.of(0x01))).toBe("04");
  });

  it("never emits the visually-ambiguous letters i, l, o, u", () => {
    const result = encode(new Uint8Array(64).fill(0xaa));
    expect(result).not.toMatch(/[ilou]/);
  });
});
