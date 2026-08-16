// Reader column layout: 2 columns of 70-80 characters each is the target;
// if the available width can't fit that, first shrink the gap between the
// two columns down to a minimum before narrowing the columns themselves
// (still within the 70-80 range), and only fall back to a single column
// once even that doesn't fit. There's no way to measure a font's real
// average glyph width without a live DOM element rendered in the same
// context the book's own iframe uses -- AVG_CHAR_WIDTH_EM is a documented
// approximation (a common typographic rule of thumb: a character is
// roughly half the font size wide), close enough to keep each column
// roughly the intended width without needing to probe font metrics
// asynchronously.
const AVG_CHAR_WIDTH_EM = 0.5;
const MIN_COLUMN_CHARS = 70;
const MAX_COLUMN_CHARS = 80;
const NORMAL_GAP_PX = 40;
const MIN_GAP_PX = 8;

export interface ColumnLayout {
  columns: 1 | 2;
  gapPx: number;
  /** Caps the render container's width once it's wider than two
   * MAX_COLUMN_CHARS-wide columns need -- otherwise each column would
   * keep growing past 80 characters on a very wide screen. null means no
   * cap is needed (the container is already narrower than that). */
  maxWidthPx: number | null;
}

function columnWidthPx(chars: number, fontPx: number): number {
  return chars * fontPx * AVG_CHAR_WIDTH_EM;
}

export function computeColumnLayout(
  containerWidthPx: number,
  fontPx: number,
): ColumnLayout {
  const maxColPx = columnWidthPx(MAX_COLUMN_CHARS, fontPx);
  const minColPx = columnWidthPx(MIN_COLUMN_CHARS, fontPx);
  const idealWidthPx = 2 * maxColPx + NORMAL_GAP_PX;

  if (containerWidthPx >= idealWidthPx) {
    return { columns: 2, gapPx: NORMAL_GAP_PX, maxWidthPx: idealWidthPx };
  }
  if (containerWidthPx >= 2 * minColPx + MIN_GAP_PX) {
    const gapPx = Math.max(MIN_GAP_PX, containerWidthPx - 2 * maxColPx);
    return { columns: 2, gapPx, maxWidthPx: null };
  }
  return { columns: 1, gapPx: 0, maxWidthPx: null };
}
