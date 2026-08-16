// A React-state-driven Bootstrap offcanvas: this app only ever pulled in
// Bootstrap's CSS/Icons, never its JS, so open/close is just a boolean
// prop toggling the "show" class plus a backdrop <div> the caller doesn't
// need to wire up itself (no data-bs-* attributes anywhere).
import { useEffect, useId, type CSSProperties, type ReactNode } from "react";
import { classNames } from "../util/classNames";

export function OffcanvasPanel({
  open,
  onClose,
  title,
  placement = "end",
  responsive,
  className,
  style,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  placement?: "start" | "end";
  /** Bootstrap's offcanvas-{breakpoint} variant: below the breakpoint this
   * behaves like a normal drawer; at/above it, it becomes a normal static
   * block instead (its own header/close button included -- Bootstrap's CSS
   * hides those automatically past the breakpoint). */
  responsive?: "md";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const base = responsive ? `offcanvas-${responsive}` : "offcanvas";
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);
  return (
    <>
      <div
        className={classNames(
          base,
          `offcanvas-${placement}`,
          open && "show",
          className,
        )}
        style={style}
        tabIndex={-1}
        role="dialog"
        aria-modal={open || undefined}
        aria-labelledby={titleId}
      >
        <div className="offcanvas-header">
          <h5 className="offcanvas-title" id={titleId}>
            {title}
          </h5>
          <button
            type="button"
            className="btn-close"
            aria-label="Close"
            onClick={onClose}
          />
        </div>
        <div className="offcanvas-body">{children}</div>
      </div>
      {open && (
        <div
          className={classNames(
            "offcanvas-backdrop show",
            responsive && `d-${responsive}-none`,
          )}
          aria-hidden="true"
          onClick={onClose}
        />
      )}
    </>
  );
}
