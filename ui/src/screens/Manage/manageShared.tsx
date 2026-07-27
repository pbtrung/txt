// Small UI pieces and helpers shared across every Manage section
// (UsersSection.tsx/BooksSection.tsx/SharesSection.tsx) and the shell
// (ManageScreen.tsx) -- kept in one place instead of each file redefining
// its own copy, since every section's forms/toolbar/list rows follow the
// exact same conventions (docs/ui.md).

import type { CSSProperties, ReactNode } from "react";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves right before the browser's next paint. Several of this
 * screen's Save/Create/Delete handlers set a `busy` flag (to show a
 * spinner) and then immediately run genuinely synchronous, CPU-bound WASM
 * work (brotli compress/decompress, AEAD encrypt/decrypt -- see
 * crypto/blob.ts) with no real `await` in between: awaiting an
 * already-resolved promise only yields to the microtask queue, not back to
 * the browser's render loop, so without a real yield point the spinner
 * never actually paints until that work is already done. `await
 * yieldToPaint()` right after setting `busy` gives the browser that one
 * real chance to paint first. */
export function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

/** "<display name> (#<id>)" -- the shared label for referencing a user from
 * somewhere else in this screen (Shares' recipient dropdown and ShareRow's
 * "Shared with" line): unlike Users' own list, which just shows the name
 * since nothing else on that row needs disambiguating, a reference *to* a
 * user needs the id too -- two accounts can share a display name (or lack
 * one), never an id. Falls back to "Unnamed user" the same way UserRow's
 * own display already does. */
export function userLabel(displayName: string | undefined, id: number): string {
  return `${displayName ?? "Unnamed user"} (#${id})`;
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
        className="form-control form-control-sm themed-control"
        style={{ maxWidth: "8rem" }}
        value={confirmText}
        onChange={(e) => onConfirmTextChange(e.target.value)}
        aria-label={`Type ${idToMatch} to confirm`}
      />
      <button
        type="button"
        className="btn btn-sm btn-danger"
        disabled={confirmText !== String(idToMatch) || busy}
        onClick={onConfirm}
      >
        Confirm delete
      </button>
    </div>
  );
}
