// Catches render/lifecycle errors anywhere below it so one screen crashing
// doesn't blank the whole app -- React only supports this via a class
// component (no hook equivalent for componentDidCatch/getDerivedStateFromError).
// Dismissing the message resets the boundary and re-renders children fresh,
// rather than leaving the user stuck until a full reload.

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
      <div className="alert alert-danger d-flex align-items-start justify-content-between gap-3 m-4" role="alert">
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
    );
  }
}
