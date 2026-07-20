// Pure helpers for the Reader screen (docs/ui.md's Screen 3), kept free of
// React/data-layer calls so they're trivially unit tested.

export function clampPartNum(partNum: number, partCount: number): number {
  if (partCount <= 0) return 1;
  return Math.max(1, Math.min(partNum, partCount));
}

/** The first maxLen characters of a line, for a bookmark's txt_preview. */
export function truncatePreview(text: string, maxLen = 60): string {
  const trimmed = text.trim();
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen).trimEnd()}…`;
}

/** Splits a part's text into its lines (docs/data_model.md's bookmarks.line indexes into this), 1-based. */
export function splitLines(partText: string): string[] {
  return partText.split(/\n{2,}/).filter((line) => line.length > 0);
}
