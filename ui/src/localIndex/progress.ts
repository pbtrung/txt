// The wordmark + spinner + current-step overlay shown while local_index.html
// verifies everything (see verify.ts/render.ts) before it ever renders the
// real app. Deliberately built to exactly match the real Unlock screen's own
// layout (UnlockScreen.tsx) rather than a different look for this one
// screen -- same outer full-viewport centering, the same Wordmark size/
// spacing, and the same spinner-border-sm + "Step N of 5" + phase-label
// block, down to Bootstrap's own pixel values (spinner-border-sm is exactly
// 1rem/0.2em border with the right edge transparent, not a generic
// two-tone ring) and its alert-danger styling for the failure state --
// reproduced here as literal inline CSS rather than actual Bootstrap
// classes, since this file is bundled straight into local_index.html (see
// ui/scripts/build-integrity.mjs), which by design can't rely on anything
// served by the CDN it's about to verify, including the app's own
// stylesheet and icon font. The wordmark's book glyph is an inlined SVG
// path (Bootstrap Icons' own "book" glyph shape, copied as raw path data,
// sized in `em` so it scales with the wordmark's font-size exactly the way
// an icon-font glyph does) rather than the icon font itself, and the brass
// accent color is a literal hex value rather than a CSS custom property,
// since neither theme.css nor the icon font is loaded pre-verification.

export type ProgressStepId =
  "fetching-manifest" | "verifying-signature" | "fetching-assets" | "verifying-hashes" | "loading-application";

const STEPS: { id: ProgressStepId; label: string }[] = [
  { id: "fetching-manifest", label: "Fetching manifest" },
  { id: "verifying-signature", label: "Verifying signature" },
  { id: "fetching-assets", label: "Fetching assets" },
  { id: "verifying-hashes", label: "Verifying asset hashes" },
  { id: "loading-application", label: "Loading application" },
];

// Bootstrap Icons' own "book" glyph -- the plain outline icon (Wordmark.tsx
// uses `bi bi-book`, not the filled `bi-book-fill`) -- copied verbatim from
// node_modules/bootstrap-icons/icons/book.svg's <path>, so this renders
// identically to the real Wordmark component without needing that font
// file loaded.
const BOOK_ICON_PATH =
  "M1 2.828c.885-.37 2.154-.769 3.388-.893 1.33-.134 2.458.063 3.112.752v9.746c-.935-.53-2.12-.603-3.213-.493-1.18." +
  "12-2.37.461-3.287.811zm7.5-.141c.654-.689 1.782-.886 3.112-.752 1.234.124 2.503.523 3.388.893v9.923c-.918-.35-" +
  "2.107-.692-3.287-.81-1.094-.111-2.278-.039-3.213.492zM8 1.783C7.015.936 5.587.81 4.287.94c-1.514.153-3.042.672" +
  "-3.994 1.105A.5.5 0 0 0 0 2.5v11a.5.5 0 0 0 .707.455c.882-.4 2.303-.881 3.68-1.02 1.409-.142 2.59.087 3.223.87" +
  "7a.5.5 0 0 0 .78 0c.633-.79 1.814-1.019 3.222-.877 1.378.139 2.8.62 3.681 1.02A.5.5 0 0 0 16 13.5v-11a.5.5 0 0" +
  " 0-.293-.455c-.952-.433-2.48-.952-3.994-1.105C10.413.809 8.985.936 8 1.783";

// theme.css's light-mode --bs-primary (the brass accent) and Bootstrap's
// own body text/secondary-text/alert-danger colors, inlined as literal hex
// values -- theme.css itself isn't loaded here, and this overlay is shown
// before the app (and its own dark-mode handling) ever mounts, so it always
// renders in this one fixed palette rather than following the OS theme.
const BRASS = "#8a6f23";
const BODY_COLOR = "#212529";
const SECONDARY_COLOR = "#6c757d";

export interface ProgressUI {
  /** Shows "Step N of 5" and that step's label. */
  advance(step: ProgressStepId): void;
  /** Stops the spinner and shows `message` in an alert-danger-styled box. */
  fail(message: string): void;
  /** Removes the whole overlay once the real app has taken over. */
  remove(): void;
}

/** Builds the wordmark/spinner/progress DOM and mounts it into `container`
 * (defaults to document.body). Returns handles to drive it as verify.ts/
 * render.ts progress. */
export function mountProgressUI(container: HTMLElement = document.body): ProgressUI {
  // Matches UnlockScreen.tsx's outer `d-flex align-items-center
  // justify-content-center vh-100` -- fixed rather than relying on
  // vh-100/body height, so it centers correctly regardless of the host
  // document's own margin/height (this file can't assume index.css's reset
  // is present, unlike the real app).
  const root = document.createElement("div");
  root.id = "boot-status";
  root.style.cssText =
    "position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; " +
    `font-family: system-ui, -apple-system, sans-serif; color: ${BODY_COLOR};`;

  // Matches UnlockScreen.tsx's inner `text-center` box, `style={{ maxWidth: "24rem" }}`.
  const inner = document.createElement("div");
  inner.style.cssText = "max-width: 24rem; width: 100%; padding: 0 1.5rem; text-align: center; box-sizing: border-box;";

  // Matches Wordmark size="lg" (`d-inline-flex align-items-center gap-2
  // fs-2`) inside UnlockScreen.tsx's `<div className="mb-4">`. Bootstrap's
  // own .fs-2 isn't just the calc() below -- it's overridden to a flat 2rem
  // at its xl breakpoint (min-width: 1200px, bootstrap.css) -- so a plain
  // inline style (which can't express a media query) would keep growing
  // past that width instead of capping the way the real Wordmark does; the
  // class+<style> rule below carries both halves of that same rule.
  const wordmarkWrap = document.createElement("div");
  wordmarkWrap.style.cssText = "margin-bottom: 1.5rem;";
  const wordmark = document.createElement("div");
  wordmark.className = "boot-wordmark";
  wordmark.style.cssText =
    "display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; " +
    "font-weight: 600; line-height: 1;";
  wordmark.innerHTML =
    `<svg width="1em" height="1em" viewBox="0 0 16 16" fill="${BRASS}" aria-hidden="true">` +
    `<path d="${BOOK_ICON_PATH}"/></svg>` +
    `<span>Skypiea</span>`;
  wordmarkWrap.appendChild(wordmark);

  // UnlockScreen.tsx's button (px-3 py-2, containing a fs-5 icon beside a
  // two-line lh-sm text block) has no equivalent action here -- there's
  // nothing to click while verifying -- but it still occupies real layout
  // height there, which this file used to just skip. Since both screens
  // center their box vertically as a whole, skipping it made this box
  // shorter than the real one, which shifted the wordmark down from where
  // it sits on Unlock (a real, empirically-confirmed few-dozen-px gap, not
  // a rounding error). This invisible placeholder reserves that same
  // height (py-2's 0.5rem top/bottom padding + the two lh-sm(1.25) small
  // (0.875rem) lines' content height, 2 * 0.875 * 1.25 = 2.1875rem) so the
  // wordmark ends up at the same position as Unlock's, not just visually
  // similar spacing.
  const buttonSpacer = document.createElement("div");
  buttonSpacer.style.cssText = "height: 3.1875rem;"; // 0.5rem + 0.5rem + 2.1875rem
  buttonSpacer.setAttribute("aria-hidden", "true");

  // Matches UnlockScreen.tsx's `mt-4 d-flex flex-column align-items-center
  // gap-1` progress block, including that mt-4 margin (the button above no
  // longer stands in for it -- see buttonSpacer above).
  const progress = document.createElement("div");
  progress.style.cssText =
    "margin-top: 1.5rem; display: flex; flex-direction: column; align-items: center; gap: 0.25rem;";

  // Matches `spinner-border spinner-border-sm text-primary mb-1` exactly:
  // 1rem square, 0.2em border, the trailing edge transparent (Bootstrap's
  // actual technique for the spin, not a plain two-tone ring), 0.75s linear.
  const spinner = document.createElement("div");
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", "Verifying");
  spinner.style.cssText =
    "display: inline-block; width: 1rem; height: 1rem; margin-bottom: 0.25rem; border-radius: 50%; " +
    `border: 0.2em solid ${BRASS}; border-right-color: transparent; animation: boot-spin 0.75s linear infinite;`;
  const styles = document.createElement("style");
  styles.textContent =
    "@keyframes boot-spin { to { transform: rotate(360deg); } } " +
    // Bootstrap's own .fs-2 rule verbatim (bootstrap.css): the calc()
    // formula normally, but overridden to a flat 2rem from its xl
    // breakpoint up, not still growing with vw past that width.
    ".boot-wordmark { font-size: calc(1.325rem + 0.9vw); } " +
    "@media (min-width: 1200px) { .boot-wordmark { font-size: 2rem; } }";

  // Matches `small text-body-secondary` (0.875rem, Bootstrap's secondary text color).
  const stepCounter = document.createElement("div");
  stepCounter.style.cssText = `font-size: 0.875rem; color: ${SECONDARY_COLOR};`;
  stepCounter.textContent = " "; // holds the line's height before the first advance(), same as Unlock's own fallback

  const stepLabel = document.createElement("div");
  stepLabel.style.cssText = `font-size: 0.875rem; color: ${SECONDARY_COLOR};`;

  progress.append(spinner, stepCounter, stepLabel);

  // Matches `alert alert-danger mt-4` exactly (Bootstrap's own alert-danger
  // palette/padding/border-radius), shown in place of the progress block on
  // failure -- not just plain red text.
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  error.style.cssText =
    "margin-top: 1.5rem; padding: 0.75rem 1.25rem; border-radius: 0.375rem; " +
    "background-color: #f8d7da; border: 1px solid #f5c2c7; color: #842029; " +
    "font-size: 0.875rem; white-space: pre-wrap; text-align: left;";
  error.hidden = true;

  inner.append(wordmarkWrap, buttonSpacer, styles, progress, error);
  root.appendChild(inner);
  container.appendChild(root);

  return {
    advance(step) {
      const index = STEPS.findIndex((s) => s.id === step);
      stepCounter.textContent = `Step ${index + 1} of ${STEPS.length}`;
      stepLabel.textContent = `${STEPS[index].label}…`;
    },
    fail(message) {
      spinner.style.display = "none";
      error.hidden = false;
      error.textContent = message;
    },
    remove() {
      root.remove();
    },
  };
}
