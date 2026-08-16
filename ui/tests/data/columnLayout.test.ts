import { describe, expect, it } from "vitest";
import { computeColumnLayout } from "../../src/data/columnLayout";

// At fontPx=18: a column is 18*0.5=9px per character -- 80 chars = 720px,
// 70 chars = 630px. These fixtures key off exactly those numbers so each
// stage boundary is exact, not approximate.
const FONT_PX = 18;
const MAX_COL_PX = 720; // 80 chars
const MIN_COL_PX = 630; // 70 chars
const MIN_GAP_PX = 8;

describe("computeColumnLayout", () => {
  it("gives 2 columns at the normal gap once there's room for 80 chars each", () => {
    const layout = computeColumnLayout(2 * MAX_COL_PX + 40, FONT_PX);
    expect(layout).toEqual({ columns: 2, gapPx: 40, maxWidthPx: 2 * MAX_COL_PX + 40 });
  });

  it("caps the container width rather than growing columns past 80 chars", () => {
    const layout = computeColumnLayout(2 * MAX_COL_PX + 400, FONT_PX);
    expect(layout.maxWidthPx).toBe(2 * MAX_COL_PX + 40);
    expect(layout.columns).toBe(2);
  });

  it("shrinks the gap toward the minimum before narrowing the columns", () => {
    // Room for 80-char columns, but only a 12px gap between them.
    const layout = computeColumnLayout(2 * MAX_COL_PX + 12, FONT_PX);
    expect(layout).toEqual({ columns: 2, gapPx: 12, maxWidthPx: null });
  });

  it("holds the gap at its minimum and narrows columns within 70-80 chars", () => {
    // Not enough for 80-char columns even at the minimum gap, but still
    // enough for a 75-char column at the minimum gap.
    const width = 2 * 675 + MIN_GAP_PX;
    const layout = computeColumnLayout(width, FONT_PX);
    expect(layout.columns).toBe(2);
    expect(layout.gapPx).toBe(MIN_GAP_PX);
  });

  it("still allows exactly 70 chars per column at the minimum gap", () => {
    const layout = computeColumnLayout(2 * MIN_COL_PX + MIN_GAP_PX, FONT_PX);
    expect(layout).toEqual({ columns: 2, gapPx: MIN_GAP_PX, maxWidthPx: null });
  });

  it("falls back to a single column once even 70 chars each doesn't fit", () => {
    const layout = computeColumnLayout(2 * MIN_COL_PX + MIN_GAP_PX - 1, FONT_PX);
    expect(layout).toEqual({ columns: 1, gapPx: 0, maxWidthPx: null });
  });

  it("scales the character-width approximation with font size", () => {
    const doubleFontPx = FONT_PX * 2;
    const layout = computeColumnLayout(2 * MAX_COL_PX + 40, doubleFontPx);
    expect(layout.columns).toBe(1);
  });
});
