import { describe, expect, it } from "vitest";

import { bytesEqual } from "./bytes";

describe("bytesEqual", () => {
  it("is true for identical arrays", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("is true for two empty arrays", () => {
    expect(bytesEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });

  it("is false for different lengths", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });

  it("is false when only the first byte differs", () => {
    expect(bytesEqual(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("is false when only the last byte differs", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 9]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("is false when every byte differs", () => {
    expect(bytesEqual(new Uint8Array([9, 9, 9]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
