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
// design, not a new downside. But a React 19 reconciler edge case
// (commitDeletionEffectsOnFiber's hostParent bookkeeping apparently getting
// corrupted during certain error-recovery commits -- "Failed to execute
// 'removeChild' on 'Node'"; the same symptom is widely reported against
// other routers too, with no confirmed upstream root cause) can leave the
// *previous* screen's real DOM behind, still fully rendered and still
// clickable, even once React's own tree has moved on. A small banner would
// leave that stale, disconnected screen visible and interactive underneath
// it; this overlay blocks it both visually and to clicks so the only way
// forward is the button below.

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
