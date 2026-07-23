// The toggle button for a useDropdown()-backed menu (Library's nav drawer,
// Reader's Info/Bookmarks) -- same open/closed styling and aria wiring in
// all three; only the icon, label, and (for Library's nav button) an extra
// centering class differ.

interface DropdownToggleButtonProps {
  open: boolean;
  onClick: () => void;
  icon: string;
  ariaLabel: string;
  title?: string;
  className?: string;
}

export function DropdownToggleButton({ open, onClick, icon, ariaLabel, title, className }: DropdownToggleButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-sm ${open ? "btn-primary" : "btn-outline-secondary border-primary"}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      aria-expanded={open}
      aria-haspopup="true"
      aria-label={ariaLabel}
      title={title}
    >
      <i className={`bi ${icon} ${open ? "" : "text-primary"}`} aria-hidden="true" />
    </button>
  );
}
