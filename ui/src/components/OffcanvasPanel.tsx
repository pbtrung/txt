// A React-state-driven Bootstrap offcanvas: this app only ever pulled in
// Bootstrap's CSS/Icons, never its JS, so open/close is just a boolean
// prop toggling the "show" class plus a backdrop <div> the caller doesn't
// need to wire up itself (no data-bs-* attributes anywhere).
import type { ReactNode } from "react";

export function OffcanvasPanel({
  open,
  onClose,
  title,
  placement = "end",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  placement?: "start" | "end";
  children: ReactNode;
}) {
  const titleId = `offcanvas-title-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <>
      <div
        className={`offcanvas offcanvas-${placement} ${open ? "show" : ""}`}
        tabIndex={-1}
        role="dialog"
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
      {open && <div className="offcanvas-backdrop show" onClick={onClose} />}
    </>
  );
}
