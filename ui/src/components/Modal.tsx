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
      <div
        className="modal-dialog-anim bg-body rounded-3 shadow-lg p-3"
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
          <h3
            className="h5 mb-0 fw-semibold text-truncate"
            style={{ minWidth: 0 }}
          >
            {title}
          </h3>
          <button
            type="button"
            className="btn btn-sm btn-light rounded-circle d-flex align-items-center justify-content-center border-0 p-0 flex-shrink-0"
            style={{ width: "1.75rem", height: "1.75rem" }}
            onClick={onClose}
            aria-label="Close"
          >
            <i
              className="bi bi-x-lg"
              style={{ fontSize: "0.75rem" }}
              aria-hidden="true"
            />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
