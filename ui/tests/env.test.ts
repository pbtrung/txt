import { describe, expect, it } from "vitest";
import { isBrowser } from "../src/env";

describe("isBrowser", () => {
  it("is false under plain Node (no window/document)", () => {
    expect(isBrowser()).toBe(false);
  });
});
