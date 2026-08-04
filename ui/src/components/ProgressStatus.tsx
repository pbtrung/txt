// The spinner + "Step N of M" + phase-label pair shown during unlock/
// refresh (VaultContext.tsx's VaultProgress) -- identical in both Unlock
// and Library except for spinner size and the fallback label shown before
// the first phase lands. The caller owns the surrounding wrapper (role=
// "status", layout, visibility/conditional-render) since that differs too
// much between the two call sites to be worth forcing into one shape.

import type { VaultProgress } from "../state/VaultContext";

interface ProgressStatusProps {
  progress: VaultProgress | null;
  fallbackLabel: string;
  spinnerClassName?: string;
}

export function ProgressStatus({
  progress,
  fallbackLabel,
  spinnerClassName,
}: ProgressStatusProps) {
  return (
    <>
      <div
        className={`spinner-border text-primary mb-1${spinnerClassName ? ` ${spinnerClassName}` : ""}`}
        aria-hidden="true"
      />
      {/* A non-breaking space holds this line's height even before the
          first phase lands, so the block doesn't visibly grow by a line
          moments after appearing. */}
      <div className="small text-body-secondary">
        {progress ? `Step ${progress.step} of ${progress.total}` : " "}
      </div>
      <div className="small text-body-secondary">
        {progress?.label ?? fallbackLabel}…
      </div>
    </>
  );
}
