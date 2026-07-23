// Shared wordmark used on the Unlock screen and the Library top bar
// (docs/ui.md's "[library] Skypiea").

interface WordmarkProps {
  size?: "md" | "lg";
}

export function Wordmark({ size = "md" }: WordmarkProps) {
  return (
    <span className={`d-inline-flex align-items-center gap-2 ${size === "lg" ? "fs-2" : ""}`}>
      <i className="bi bi-book text-primary" aria-hidden="true" />
      <span className="fw-semibold">Skypiea</span>
    </span>
  );
}
