// The wordmark + spinner + current-step overlay shown while local_index.html
// verifies everything (see verify.ts/render.ts) before it ever renders the
// real app -- styled to match the real Unlock screen's own spinner
// (Wordmark, then a spinner with a "Step N of 5" counter and the current
// phase's label underneath, same as UnlockScreen.tsx/VaultContext's
// progress -- see docs/ui.md's Screen 1), rather than a different look for
// this one screen. Deliberately dependency-free inline DOM/CSS (including
// the wordmark's book glyph, an inlined SVG path rather than Bootstrap
// Icons' font) -- this file gets bundled straight into local_index.html
// (see ui/scripts/build-integrity.mjs), which by design can't rely on
// anything served by the CDN it's about to verify, including the app's own
// Bootstrap stylesheet and icon font.

export type ProgressStepId =
  "fetching-manifest" | "verifying-signature" | "fetching-assets" | "verifying-hashes" | "loading-application";

const STEPS: { id: ProgressStepId; label: string }[] = [
  { id: "fetching-manifest", label: "Fetching manifest" },
  { id: "verifying-signature", label: "Verifying signature" },
  { id: "fetching-assets", label: "Fetching assets" },
  { id: "verifying-hashes", label: "Verifying asset hashes" },
  { id: "loading-application", label: "Loading application" },
];

// Bootstrap Icons' own "book" glyph, as a raw path -- copied as SVG path
// data (not the icon font glyph itself), so this renders identically to
// the real Wordmark component without needing that font file loaded.
const BOOK_ICON_PATH =
  "M8 2.75C7.146 2.3 5.958 2.005 4.71 2c-1.283 0-2.516.29-3.51.858A.5.5 0 0 0 .5 3.5v9.5a.5.5 0 0 0 .5.5c.166 0 " +
  "1.5-.833 3.5-.833 1.5 0 2.5.5 3.5 1v-9.5c-.29-.29-1-.917-1-1.417zm8.99.108a.5.5 0 0 0-.99.017v9.5c0 1.5-1 " +
  "1.833-3.5 1.833-2 0-3.334.833-3.5.833V3.5c1-.5 2-1 3.5-1 1.248.005 2.436.3 3.29.75z";

// The brass accent color (theme.css's --bs-primary), inlined as a literal
// hex value rather than a CSS custom property -- theme.css itself isn't
// loaded here either.
const BRASS = "#8a6f23";

export interface ProgressUI {
  /** Shows "Step N of 5" and that step's label. */
  advance(step: ProgressStepId): void;
  /** Stops the spinner and shows `message` in its place. */
  fail(message: string): void;
  /** Removes the whole overlay once the real app has taken over. */
  remove(): void;
}

/** Builds the wordmark/spinner/progress DOM and mounts it into `container`
 * (defaults to document.body). Returns handles to drive it as verify.ts/
 * render.ts progress. */
export function mountProgressUI(container: HTMLElement = document.body): ProgressUI {
  const root = document.createElement("div");
  root.id = "boot-status";
  root.style.cssText =
    "font-family: system-ui, sans-serif; max-width: 24rem; margin: 6rem auto; padding: 1.5rem; text-align: center;";

  const wordmark = document.createElement("div");
  wordmark.style.cssText =
    "display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 2rem; " +
    "font-size: 1.5rem; font-weight: 600; color: #212529;";
  wordmark.innerHTML =
    `<svg width="28" height="28" viewBox="0 0 16 16" fill="${BRASS}" aria-hidden="true">` +
    `<path d="${BOOK_ICON_PATH}"/></svg>` +
    `<span>Skypiea</span>`;

  const spinner = document.createElement("div");
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", "Verifying");
  spinner.style.cssText =
    "width: 2rem; height: 2rem; margin: 0 auto 1rem; border-radius: 50%; " +
    `border: 0.2rem solid #ccc; border-top-color: ${BRASS}; animation: boot-spin 0.8s linear infinite;`;
  const keyframes = document.createElement("style");
  keyframes.textContent = "@keyframes boot-spin { to { transform: rotate(360deg); } }";

  const stepCounter = document.createElement("div");
  stepCounter.style.cssText = "font-size: 0.875rem; color: #6c757d;";
  stepCounter.textContent = " "; // holds the line's height before the first advance()

  const stepLabel = document.createElement("div");
  stepLabel.style.cssText = "font-size: 0.875rem; color: #6c757d;";

  const error = document.createElement("p");
  error.style.cssText = "color: #b00020; margin-top: 1rem; white-space: pre-wrap; font-size: 0.875rem;";
  error.hidden = true;

  root.append(wordmark, keyframes, spinner, stepCounter, stepLabel, error);
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
