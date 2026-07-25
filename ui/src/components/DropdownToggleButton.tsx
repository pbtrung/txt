// The toggle button for a useDropdown()-backed menu (Library's nav drawer,
// Reader's Info/Bookmarks, Manage's nav drawer) -- same open/closed
// styling and aria wiring in all four; only the icon, label, and (for
// Library's/Manage's nav buttons) an extra centering class differ.

interface DropdownToggleButtonProps {
  open: boolean;
  onClick: () => void;
  icon: string;
  ariaLabel: string;
  title?: string;
  className?: string;
  disabled?: boolean;
}

export function DropdownToggleButton({
  open,
  onClick,
  icon,
  ariaLabel,
  title,
  className,
  disabled,
}: DropdownToggleButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-sm ${open ? "btn-primary" : "btn-outline-secondary border-primary"}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={open}
      aria-haspopup="true"
      aria-label={ariaLabel}
      title={title}
    >
      <i className={`bi ${icon} ${open ? "" : "text-primary"}`} aria-hidden="true" />
    </button>
  );
}
