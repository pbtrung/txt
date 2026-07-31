// A hand-rolled modal dialog -- no Bootstrap JS in this project (only its
// CSS), so the backdrop/Escape/close handling here is hand-rolled instead
// of relying on Bootstrap's modal plugin, same reasoning as
// hooks/useDropdown.ts's own "close on outside click or Escape". The
// fade/rise-in animation (index.css's .modal-backdrop-anim/.modal-dialog-anim)
// is likewise hand-rolled rather than Bootstrap's .fade/.show transition
// classes, which only animate under its JS. Used by the admin Manage
// screen's Create/Edit/Delete panels.

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
      className="modal-backdrop-anim position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center p-3"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)", zIndex: 1050 }}
      onClick={onClose}
    >
      {/* stopPropagation so a click *inside* the dialog doesn't bubble to
          the backdrop above and close it. A fixed width (not just a
          maxWidth cap) so every panel this screen opens -- create/edit/
          delete alike, whether its content is a full form or a single
          confirm field -- renders at the same size instead of each
          shrinking to its own content's width. maxWidth is just the
          narrow-viewport fallback. maxHeight matches exactly what the
          backdrop's own p-3 (1rem top + 1rem bottom) leaves -- not an
          arbitrary percentage like 85vh, which was leaving real unused
          space below the dialog on a short viewport (confirmed at
          375x667) while still forcing an internal scrollbar on taller
          panels (e.g. Users' Save-credentials step) that would have fit
          in that leftover space. overflowY:auto still scrolls internally
          for the rare panel taller than even this. */}
      <div
        className="modal-dialog-anim bg-body rounded-4 shadow-lg p-3"
        style={{
          width: "34rem",
          maxWidth: "92vw",
          maxHeight: "calc(100vh - 2rem)",
          overflowY: "auto",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="d-flex align-items-center justify-content-between gap-2 mb-2 pb-2 border-bottom">
          {/* minWidth:0 lets a long title actually truncate instead of
              forcing this flex item (and the close button beside it)
              wider than the dialog -- flex items default to
              min-width:auto, which ignores text-truncate on its own. */}
          <h3 className="h5 mb-0 fw-semibold text-truncate" style={{ minWidth: 0 }}>
            {title}
          </h3>
          <button
            type="button"
            className="btn btn-sm btn-light rounded-circle d-flex align-items-center justify-content-center border-0 p-0 flex-shrink-0"
            style={{ width: "1.75rem", height: "1.75rem" }}
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
