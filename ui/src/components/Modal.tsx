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
          the backdrop above and close it. */}
      <div
        className="bg-body rounded shadow-lg p-3"
        style={{ maxWidth: "30rem", width: "100%", maxHeight: "85vh", overflowY: "auto" }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h3 className="h6 mb-0">{title}</h3>
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onClose} aria-label="Close">
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
