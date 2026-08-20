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
        "text-center text-base-content/60",
        compact
          ? "absolute top-1/2 left-1/2 w-full -translate-x-1/2 -translate-y-1/2"
          : "mx-auto w-full px-4 py-12",
      )}
    >
      <div>
        <span className="loading loading-spinner loading-sm mr-2" aria-hidden="true" />
        {children}
      </div>
      {progress && (
        <div role="status" className="mt-2 text-sm">
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
        compact ? "my-2 px-3 py-2 text-sm" : "mx-auto w-full px-4 py-12",
        error ? "alert alert-error" : "text-base-content/60",
      )}
    >
      {children}
    </p>
  );
}
