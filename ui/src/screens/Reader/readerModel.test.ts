import { describe, expect, it } from "vitest";

import { clampPartNum, formatRelativeTime } from "./readerModel";

describe("formatRelativeTime", () => {
  const now = 1_700_000_000_000;

  it("says 'Just now' for anything under a minute", () => {
    expect(formatRelativeTime(now, now)).toBe("Just now");
    expect(formatRelativeTime(now - 59_000, now)).toBe("Just now");
  });

  it("formats minutes", () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelativeTime(now - 60_000, now)).toBe("1 minute ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe("3 hours ago");
  });

  it("formats days", () => {
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe("2 days ago");
    expect(formatRelativeTime(now - 6 * 24 * 60 * 60_000, now)).toBe("6 days ago");
  });
});

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
