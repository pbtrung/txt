// Pure helpers for the Reader screen (docs/ui.md's Screen 3), kept free of
// React/data-layer calls so they're trivially unit tested.

/** "Just now" / "5 minutes ago" / "2 days ago", matching docs/ui.md's bookmark list. */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diffSeconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (diffSeconds < 60) return "Just now";

  const units: [number, string][] = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
    [30, "month"],
    [12, "year"],
  ];
  let value = diffSeconds;
  let unitName = "second";
  for (const [size, name] of units) {
    if (value < size) break;
    value = Math.floor(value / size);
    unitName = name;
  }
  return `${value} ${unitName}${value === 1 ? "" : "s"} ago`;
}

export function clampPartNum(partNum: number, partCount: number): number {
  if (partCount <= 0) return 1;
  return Math.max(1, Math.min(partNum, partCount));
}
