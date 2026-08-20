import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "react-aria-components";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Unhandled UI error", error, info.componentStack);
  }

  private reload = () => window.location.reload();

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="mx-auto w-full px-4 py-12 text-center" role="alert">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-base-content/60">
          Reload the app to start a fresh session.
        </p>
        <Button className="btn btn-primary mt-4" onPress={this.reload}>
          Reload
        </Button>
      </main>
    );
  }
}
