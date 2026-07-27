import { describe, expect, it } from "vitest";

import { truncateOptionLabel } from "./manageShared";

describe("truncateOptionLabel", () => {
  it("leaves text at or under the max length untouched", () => {
    expect(truncateOptionLabel("A short title", 50)).toBe("A short title");
    const exactlyMax = "x".repeat(50);
    expect(truncateOptionLabel(exactlyMax, 50)).toBe(exactlyMax);
  });

  it("truncates longer text with a trailing ellipsis, keeping the total length at maxLength", () => {
    const longTitle = "x".repeat(80);
    const result = truncateOptionLabel(longTitle, 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, -1)).toBe("x".repeat(49));
  });

  it("defaults to a 40-character max when none is given -- measured against the project's smallest supported viewport (375x667), see the function's own doc comment", () => {
    expect(truncateOptionLabel("x".repeat(80))).toHaveLength(40);
  });
});
