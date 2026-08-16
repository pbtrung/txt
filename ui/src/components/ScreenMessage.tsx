import type { ReactNode } from "react";
import { classNames } from "../util/classNames";

export function LoadingMessage({ children }: { children: ReactNode }) {
  return (
    <div className="container py-5 text-center text-muted">
      <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
      {children}
    </div>
  );
}

export function ScreenMessage({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <p
      role={error ? "alert" : undefined}
      className={classNames(
        "container py-5 text-center",
        error ? "alert alert-danger" : "text-muted",
      )}
    >
      {children}
    </p>
  );
}
