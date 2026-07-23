// Catches render/lifecycle errors anywhere below it so one screen crashing
// doesn't blank the whole app -- React only supports this via a class
// component (no hook equivalent for componentDidCatch/getDerivedStateFromError).
// Dismissing the message resets the boundary and re-renders children fresh,
// rather than leaving the user stuck until a full reload.
//
// The fallback is a full-viewport, opaque overlay rather than a small inline
// banner: this sits above VaultProvider (see App.tsx), so dismissing always
// remounts it fresh (session reset, landing back on Unlock) regardless of
// what was caught -- consistent with VaultContext's own no-persistence
// design, not a new downside. This was originally built to mitigate a
// "Failed to execute 'removeChild' on 'Node'" crash that could leave the
// *previous* screen's real DOM behind, still fully rendered and still
// clickable, once caught -- at the time it looked like a React 19
// reconciler edge case with no confirmed root cause, but it turned out to
// be a real bug elsewhere: crypto/brotli.ts's dynamic `import("brotli-wasm")`
// was splitting into its own bundle chunk that imported a shared helper
// back from the entry chunk, which broke local_index.html's inline
// (`src`-less) entry script badly enough to double-mount the whole app --
// fixed at the source by vite.config.ts's `inlineDynamicImports: true`, not
// anything in this file. The full-viewport overlay is kept anyway as
// generally good crash UX (a small banner would still leave whatever's
// underneath visible and interactive, which is worse for a genuinely
// broken screen regardless of cause), not because this specific bug class
// is still expected.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { verbose } from "../log";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    verbose("ErrorBoundary caught", error, errorInfo.componentStack);
  }

  private handleClose = (): void => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div
        className="position-fixed top-0 start-0 w-100 h-100 bg-body d-flex align-items-center justify-content-center p-4"
        style={{ zIndex: 2000 }}
      >
        <div className="alert alert-danger d-flex flex-column gap-2 w-100" role="alert" style={{ maxWidth: "28rem" }}>
          <div className="d-flex align-items-start justify-content-between gap-3">
            <div>{error.message || "Something went wrong."}</div>
            <button
              type="button"
              className="btn btn-xs btn-outline-secondary border-0 flex-shrink-0"
              aria-label="Close"
              onClick={this.handleClose}
            >
              <i className="bi bi-x-lg" aria-hidden="true" />
            </button>
          </div>
          <div className="small text-body-secondary">You'll need to unlock your library again to continue.</div>
        </div>
      </div>
    );
  }
}
