// Small UI pieces and helpers shared across every Manage section
// (UsersSection.tsx/BooksSection.tsx/SharesSection.tsx) and the shell
// (ManageScreen.tsx) -- kept in one place instead of each file redefining
// its own copy, since every section's forms/toolbar/list rows follow the
// exact same conventions (docs/ui.md).

import type { CSSProperties, ReactNode } from "react";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Triggers a browser download of `data` as pretty-printed JSON -- used for
 * the credential/root-key files the Users section hands off. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------- Toolbar ---

/** One Create/Edit/Delete action, described declaratively rather than as
 * JSX -- each section computes its own applicable buttons (which differ:
 * Users has all three, Books has no Create, Shares' Delete revokes
 * immediately with no confirm step) and the shell renders them in one
 * place, beside the search box, instead of each section rendering its own
 * toolbar row inline above its list. */
export interface ToolbarButtonConfig {
  key: string;
  icon: string;
  label: string;
  variant?: "secondary" | "danger";
  disabled?: boolean;
  onClick: () => void;
}

function ToolbarButton({ icon, label, variant = "secondary", disabled, onClick }: ToolbarButtonConfig) {
  // "secondary" (Create/Edit) matches the same brass-bordered, brass-icon
  // language as every other bordered button in the app (Refresh/Lock,
  // the drawer toggle -- docs/ui.md) instead of Bootstrap's plain gray
  // outline-secondary. "danger" (Delete) stays Bootstrap's own red --
  // destructive actions are the one deliberate exception to the brass theme.
  // btn-sm matches the search box's own form-control-sm (see
  // ManageToolbar) -- both flush children of the same .input-group, so
  // they need to agree on height, and small keeps the top bar compact.
  const isDanger = variant === "danger";
  return (
    <button
      type="button"
      className={`btn btn-sm d-flex align-items-center gap-1 ${isDanger ? "btn-outline-danger" : "btn-outline-secondary border-primary"}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      <i className={`bi ${icon} ${isDanger ? "" : "text-primary"}`} aria-hidden="true" />
      {/* Label text collapses to icon-only below sm -- same breakpoint the
          mobile drawer's own "Skypiea" label already hides at -- so the
          group stays compact next to the search box on a narrow screen. */}
      <span className="d-none d-sm-inline">{label}</span>
    </button>
  );
}

/** A section's applicable actions, rendered as flat/flush children so
 * Bootstrap's .input-group CSS (see ManageScreen.tsx's search box) merges
 * them with the search box into one seamless control -- same height,
 * adjoining borders -- instead of a separate button group floating beside
 * it. */
export function ManageToolbar({ buttons }: { buttons: ToolbarButtonConfig[] }) {
  return (
    <>
      {buttons.map(({ key, ...button }) => (
        <ToolbarButton key={key} {...button} />
      ))}
    </>
  );
}

// -------------------------------------------------------------- Forms ---

/** One labeled field, stacked label-above-input -- the one field layout
 * every form in this screen uses, instead of some forms stacking fields
 * and others laying them out in a row. */
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

/** Every form/confirm-panel in this screen caps its width to this, instead
 * of stretching to whatever's left of the (now much wider, fixed-size)
 * Modal it's shown in. */
export const FORM_WIDTH = { maxWidth: "26rem" };

/** Users/Books' Delete panels both gate their "Confirm delete" button
 * behind typing the selected row's own numeric id back -- this screen's
 * only confirm-before-destructive-action pattern (Shares' revoke, and
 * every other delete in the app, e.g. Library's bookmark "x", fire
 * immediately instead). */
export function ConfirmDeleteField({
  idToMatch,
  confirmText,
  onConfirmTextChange,
  onConfirm,
  busy,
}: {
  idToMatch: number;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="d-flex gap-2 align-items-center">
      <input
        type="text"
        className="form-control themed-control"
        style={{ maxWidth: "8rem" }}
        value={confirmText}
        onChange={(e) => onConfirmTextChange(e.target.value)}
        aria-label={`Type ${idToMatch} to confirm`}
      />
      <button
        type="button"
        className="btn btn-danger"
        disabled={confirmText !== String(idToMatch) || busy}
        onClick={onConfirm}
      >
        Confirm delete
      </button>
    </div>
  );
}

// --------------------------------------------------------- List rows ---

/** A single-line, icon-led, selectable list row -- used by SharesSection
 * (a share has no dedicated row component of its own the way Users/Books
 * do, since it's just a txt title -> recipient id line). */
export function SelectableRow({
  icon,
  selected,
  onClick,
  children,
  style,
}: {
  icon: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      style={style}
      className={`list-group-item list-group-item-action d-flex align-items-center gap-2 text-start ${selected ? "active" : ""}`}
      onClick={onClick}
    >
      <i className={`bi ${icon} ${selected ? "" : "text-body-secondary"} flex-shrink-0`} aria-hidden="true" />
      <span className="text-truncate">{children}</span>
    </button>
  );
}
