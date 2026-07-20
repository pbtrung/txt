// The same progress indicator style used in the Library list and the
// Reader's bottom bar (docs/ui.md), so a book's position reads consistently
// in both places.

interface ProgressBarProps {
  percent: number; // 0-100
}

export function ProgressBar({ percent }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="progress"
      style={{ height: "0.5rem" }}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-bar" style={{ width: `${clamped}%` }} />
    </div>
  );
}
