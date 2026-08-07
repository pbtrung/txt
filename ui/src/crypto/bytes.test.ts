import { describe, expect, it } from "vitest";
import { zeroBytes } from "./bytes";

describe("zeroBytes", () => {
  it("overwrites every byte in place", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    zeroBytes(bytes);
    expect(bytes).toEqual(new Uint8Array(5));
  });

  it("mutates the same underlying buffer other references still see", () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const alias = bytes;
    zeroBytes(bytes);
    expect(alias).toEqual(new Uint8Array(3));
  });

  it("is a no-op on an empty array", () => {
    const bytes = new Uint8Array(0);
    expect(() => zeroBytes(bytes)).not.toThrow();
  });
});
