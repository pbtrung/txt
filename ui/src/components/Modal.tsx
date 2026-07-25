// A hand-rolled modal dialog -- no Bootstrap JS in this project (only its
// CSS), so the backdrop/Escape/close handling here is hand-rolled instead
// of relying on Bootstrap's modal plugin, same reasoning as
// hooks/useDropdown.ts's own "close on outside click or Escape". Used by
// the admin Manage screen's Create/Edit/Delete panels.

import { useEffect, type ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center p-3"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)", zIndex: 1050 }}
      onClick={onClose}
    >
      {/* stopPropagation so a click *inside* the dialog doesn't bubble to
          the backdrop above and close it. No fixed width here -- the
          dialog shrink-wraps to its content (typically a ~26rem-wide form)
          up to maxWidth instead of always rendering at the full 30rem,
          which otherwise left a slab of unused space beside short content
          and pushed the close button needlessly far from the title. */}
      <div
        className="bg-body rounded shadow-lg p-3"
        style={{ maxWidth: "30rem", maxHeight: "85vh", overflowY: "auto" }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="d-flex align-items-center justify-content-between gap-2 mb-3">
          {/* minWidth:0 lets a long title actually truncate instead of
              forcing this flex item (and the close button beside it)
              wider than the dialog -- flex items default to
              min-width:auto, which ignores text-truncate on its own. */}
          <h3 className="h6 mb-0 text-truncate" style={{ minWidth: 0 }}>
            {title}
          </h3>
          <button
            type="button"
            className="btn btn-sm border-0 p-1 lh-1 text-body-secondary flex-shrink-0"
            onClick={onClose}
            aria-label="Close"
          >
            <i className="bi bi-x-lg" style={{ fontSize: "0.75rem" }} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
