import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type { ActivityDiagnostic as Diagnostic } from "../types";
import { errorText, formatBytes } from "../view-model";

export function ActivityDiagnostic({ activityId, generation }: { activityId: string; generation: number }) {
  const [capture, setCapture] = useState<Diagnostic>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  useLayoutEffect(() => {
    request.current += 1; setCapture(undefined); setError(undefined); setPending(false); setCopied(false);
    return () => { request.current += 1; };
  }, [activityId, generation]);
  const load = async () => {
    const current = ++request.current;
    setPending(true); setError(undefined); setCopied(false);
    try {
      const value = await desktopApi.activityDiagnostic(activityId, generation);
      if (request.current === current) setCapture(value);
    } catch (value) { if (request.current === current) setError(errorText(value)); }
    finally { if (request.current === current) setPending(false); }
  };
  return <details className="activity-diagnostic" onToggle={event => {
    if (event.currentTarget.open && capture === undefined && !pending) void load();
  }}>
    <summary data-focusable>View preparation log</summary>
    {pending && <p role="status">Reading the retained log…</p>}
    {error && <p role="alert">{error}</p>}
    {capture?.length === 0 && <p>No retained diagnostic capture is available. Older activity details may be available in a redacted support bundle in Settings.</p>}
    {capture?.map(phase => <section key={phase.phase}>
      <h3>{phase.phase === "preparation.extract" ? "Preparing source data" : "Running game setup"}</h3>
      <p>{phase.complete ? "Capture reached the end of both output streams." : "Capture is incomplete. Only the output saved before the last observation is available."}</p>
      {(phase.stdout.truncated || phase.stderr.truncated) && <p>Some output was omitted because it exceeded the {formatBytes(phase.stream_limit_bytes)} capture limit per stream.</p>}
      <p>Last saved: {new Date(phase.updated_at * 1000).toLocaleString()}</p>
      <h4>Standard output</h4><pre tabIndex={0} aria-label="Preparation standard output">{phase.stdout.text || "No standard output was captured."}</pre>
      <h4>Standard error</h4><pre tabIndex={0} aria-label="Preparation standard error">{phase.stderr.text || "No standard error was captured."}</pre>
    </section>)}
    {!!capture?.length && <button data-focusable onClick={() => {
        const current = request.current;
        void copyText(JSON.stringify(capture, null, 2))
          .then(() => { if (request.current === current) setCopied(true); })
          .catch(() => { if (request.current === current) setCopied(false); });
      }}>{copied ? "Copied" : "Copy retained log"}</button>}
    <button data-focusable disabled={pending} onClick={() => { void load(); }}>Refresh captured log</button>
  </details>;
}
