import { Component, type ErrorInfo, type ReactNode } from "react";

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
  return <main className="bootstrap-recovery" role="alert">
    <p className="eyebrow">DESKTOP RECOVERY</p>
    <h1>Portcove hit a display error</h1>
    <p>Your library operation state remains owned by the backend. Reload the interface to reconnect to it.</p>
    <pre>{error.message || "Unknown render failure"}</pre>
    <button type="button" onClick={() => window.location.reload()}>Reload Portcove</button>
  </main>;
}
