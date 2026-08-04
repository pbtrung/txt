import type { CSSProperties, ReactNode } from "react";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ToolbarButtonConfig {
  key: string;
  icon: string;
  label: string;
  variant?: "secondary" | "danger";
  disabled?: boolean;
  onClick: () => void;
}

function ToolbarButton({
  icon,
  label,
  variant = "secondary",
  disabled,
  onClick,
}: ToolbarButtonConfig) {
  const isDanger = variant === "danger";
  return (
    <button
      type="button"
      className={`btn btn-sm d-flex align-items-center gap-1 ${isDanger ? "btn-outline-danger" : "btn-outline-secondary border-primary"}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      <i
        className={`bi ${icon} ${isDanger ? "" : "text-primary"}`}
        aria-hidden="true"
      />
      <span className="d-none d-sm-inline">{label}</span>
    </button>
  );
}

export function ManageToolbar({ buttons }: { buttons: ToolbarButtonConfig[] }) {
  return (
    <>
      {buttons.map(({ key, ...button }) => (
        <ToolbarButton key={key} {...button} />
      ))}
    </>
  );
}

export function userLabel(user: {
  id: string;
  displayName?: string;
  email?: string;
}): string {
  const displayName = user.displayName?.trim() || user.email?.trim();
  return displayName ? `${displayName} (${user.id})` : user.id;
}

export function truncateOptionLabel(text: string, maxLength = 40): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function FormField({
  label,
  htmlFor,
  style,
  children,
}: {
  label: string;
  htmlFor: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className="mb-2" style={style}>
      <label htmlFor={htmlFor} className="form-label small mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

export function ConfirmDeleteField({
  idToMatch,
  confirmText,
  onConfirmTextChange,
  onConfirm,
  busy,
}: {
  idToMatch: string;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="d-flex gap-2 align-items-center">
      <input
        type="text"
        className="form-control form-control-sm themed-control"
        style={{ maxWidth: "14rem" }}
        value={confirmText}
        onChange={(e) => onConfirmTextChange(e.target.value)}
        aria-label={`Type ${idToMatch} to confirm`}
      />
      <button
        type="button"
        className="btn btn-sm btn-danger"
        disabled={confirmText !== idToMatch || busy}
        onClick={onConfirm}
      >
        Confirm delete
      </button>
    </div>
  );
}
