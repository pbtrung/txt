import { describe, expect, it } from "vitest";

import { clampPartNum, splitLines, truncatePreview } from "./readerModel";

describe("clampPartNum", () => {
  it("clamps within [1, partCount]", () => {
    expect(clampPartNum(0, 41)).toBe(1);
    expect(clampPartNum(14, 41)).toBe(14);
    expect(clampPartNum(99, 41)).toBe(41);
  });

  it("returns 1 when there are no parts", () => {
    expect(clampPartNum(5, 0)).toBe(1);
  });
});

describe("truncatePreview", () => {
  it("returns short text unchanged", () => {
    expect(truncatePreview("Cerryl learns the truth.")).toBe("Cerryl learns the truth.");
  });

  it("truncates to maxLen and appends an ellipsis", () => {
    const line = "Powerful white mages killed Cerryl's father to protect their control of the world's magic.";
    const result = truncatePreview(line, 60);
    expect(result.length).toBeLessThanOrEqual(61); // 60 chars + "…"
    expect(result.endsWith("…")).toBe(true);
    expect(line.startsWith(result.slice(0, -1))).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(truncatePreview("   padded text   ")).toBe("padded text");
  });
});

describe("splitLines", () => {
  it("splits on blank-line separators and drops empty entries", () => {
    expect(splitLines("First paragraph.\n\nSecond paragraph.\n\n\nThird.")).toEqual([
      "First paragraph.",
      "Second paragraph.",
      "Third.",
    ]);
  });

  it("returns a single line for text with no blank-line separators", () => {
    expect(splitLines("Just one line of text")).toEqual(["Just one line of text"]);
  });
});
