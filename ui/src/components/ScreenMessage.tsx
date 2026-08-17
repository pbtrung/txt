import type { ReactNode } from "react";
import { classNames } from "../util/classNames";

interface LoadingProgress {
  label: string;
  step: number;
  total: number;
}

export function LoadingMessage({
  children,
  progress,
  compact = false,
}: {
  children: ReactNode;
  progress?: LoadingProgress;
  compact?: boolean;
}) {
  return (
    <div
      className={classNames(
        "text-center text-muted",
        compact
          ? "position-absolute top-50 start-50 translate-middle w-100"
          : "container py-5",
      )}
    >
      <div>
        <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
        {children}
      </div>
      {progress && (
        <div role="status" className="small mt-2">
          {progress.label} (step {progress.step} of {progress.total})
        </div>
      )}
    </div>
  );
}

export function ScreenMessage({
  children,
  error = false,
  compact = false,
}: {
  children: ReactNode;
  error?: boolean;
  compact?: boolean;
}) {
  return (
    <p
      role={error ? "alert" : undefined}
      className={classNames(
        "text-center",
        compact ? "small my-2 py-2 px-3" : "container py-5",
        error ? "alert alert-danger" : "text-muted",
      )}
    >
      {children}
    </p>
  );
}
