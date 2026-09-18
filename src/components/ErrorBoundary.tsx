import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertOctagon, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keeps a rendering failure from turning the page into a blank screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[TalkQ Web] render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="grid h-full w-full place-items-center p-6">
        <div className="max-w-md rounded-xl border border-destructive/40 bg-card/80 p-5 text-center backdrop-blur">
          <AlertOctagon className="mx-auto h-6 w-6 text-destructive" />
          <h1 className="mt-3 text-sm font-semibold text-foreground">Something broke in the UI</h1>
          <p className="mt-1.5 break-words font-mono text-[11px] text-muted-foreground">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-foreground hover:bg-accent"
          >
            <RotateCcw className="h-3 w-3" />
            Try again
          </button>
        </div>
      </div>
    );
  }
}
