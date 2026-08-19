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
      <main className="container py-5 text-center" role="alert">
        <h1 className="h4">Something went wrong</h1>
        <p className="text-muted">Reload the app to start a fresh session.</p>
        <Button className="btn btn-primary" onPress={this.reload}>
          Reload
        </Button>
      </main>
    );
  }
}
