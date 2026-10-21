import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  report?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error?: Error;
}

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.report?.(error, info);
  }

  render() {
    if (this.state.error) return <RenderRecovery error={this.state.error} />;
    return this.props.children;
  }
}

function RenderRecovery({ error }: { error: Error }) {
  return (
    <main className="bootstrap-recovery" aria-labelledby="display-error-title">
      <section className="bootstrap-recovery-content" role="alert">
        <h1 id="display-error-title">Display error</h1>
        <p>
          The Portcove window encountered an error. Reload it to reconnect and check the status of
          any active task.
        </p>
        <Button type="button" variant="primary" onClick={() => window.location.reload()}>
          Reload Portcove
        </Button>
        <details className="bootstrap-recovery-details">
          <summary>Display error details</summary>
          <textarea
            readOnly
            aria-label="Display error diagnostics"
            value={error.message || "Unknown display error"}
          />
        </details>
      </section>
    </main>
  );
}
