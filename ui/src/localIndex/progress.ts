// The spinner + fixed 5-line progress list shown while local_index.html
// verifies everything (see verify.ts/render.ts) before it ever renders the
// real app. Deliberately dependency-free inline DOM/CSS -- this file gets
// bundled straight into local_index.html (see ui/scripts/build-integrity.mjs),
// which by design can't rely on anything served by the CDN it's about to
// verify, including the app's own Bootstrap stylesheet.

export type ProgressStepId =
  "fetching-manifest" | "verifying-signature" | "fetching-assets" | "verifying-hashes" | "loading-application";

type StepStatus = "pending" | "active" | "done" | "failed";

const STEPS: { id: ProgressStepId; label: string }[] = [
  { id: "fetching-manifest", label: "Fetching manifest" },
  { id: "verifying-signature", label: "Verifying signature" },
  { id: "fetching-assets", label: "Fetching assets" },
  { id: "verifying-hashes", label: "Verifying asset hashes" },
  { id: "loading-application", label: "Loading application" },
];

const STATUS_MARKER: Record<StepStatus, string> = {
  pending: "○",
  active: "◐",
  done: "✓",
  failed: "✗",
};

export interface ProgressUI {
  /** Marks every step before `step` done and `step` itself active. */
  advance(step: ProgressStepId): void;
  /** Marks the current step failed and shows `message`. */
  fail(message: string): void;
  /** Removes the whole progress overlay once the real app has taken over. */
  remove(): void;
}

/** Builds the spinner + progress list DOM and mounts it into `container`
 * (defaults to document.body). Returns handles to drive it as verify.ts/
 * render.ts progress. */
export function mountProgressUI(container: HTMLElement = document.body): ProgressUI {
  const root = document.createElement("div");
  root.id = "boot-status";
  root.style.cssText =
    "font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 1.5rem; text-align: center;";

  const spinner = document.createElement("div");
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", "Verifying");
  spinner.style.cssText =
    "width: 2.5rem; height: 2.5rem; margin: 0 auto 1.5rem; border-radius: 50%; " +
    "border: 0.25rem solid #ccc; border-top-color: #333; animation: boot-spin 0.8s linear infinite;";
  const keyframes = document.createElement("style");
  keyframes.textContent = "@keyframes boot-spin { to { transform: rotate(360deg); } }";

  const list = document.createElement("ol");
  list.style.cssText = "list-style: none; padding: 0; margin: 0; text-align: left;";

  const items = new Map<ProgressStepId, HTMLLIElement>();
  for (const step of STEPS) {
    const li = document.createElement("li");
    li.dataset.step = step.id;
    li.style.cssText = "padding: 0.25rem 0;";
    li.textContent = `${STATUS_MARKER.pending} ${step.label}`;
    list.appendChild(li);
    items.set(step.id, li);
  }

  const error = document.createElement("p");
  error.style.cssText = "color: #b00020; margin-top: 1rem; white-space: pre-wrap;";
  error.hidden = true;

  root.append(keyframes, spinner, list, error);
  container.appendChild(root);

  function setStatus(step: ProgressStepId, status: StepStatus): void {
    const li = items.get(step)!;
    li.dataset.status = status;
    const label = STEPS.find((s) => s.id === step)!.label;
    li.textContent = `${STATUS_MARKER[status]} ${label}`;
  }

  let activeStep: ProgressStepId | null = null;

  return {
    advance(step) {
      const index = STEPS.findIndex((s) => s.id === step);
      for (let i = 0; i < STEPS.length; i++) {
        if (i < index) setStatus(STEPS[i].id, "done");
        else if (i === index) setStatus(STEPS[i].id, "active");
      }
      activeStep = step;
    },
    fail(message) {
      if (activeStep) setStatus(activeStep, "failed");
      spinner.style.display = "none";
      error.hidden = false;
      error.textContent = message;
    },
    remove() {
      root.remove();
    },
  };
}
