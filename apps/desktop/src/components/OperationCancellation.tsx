import { useState } from "react";
import { desktopApi } from "../api";
import type { CancellationState } from "../types";
import { errorText } from "../view-model";

export function OperationCancellation({ operationId, state, label = "Cancel operation" }: { operationId: string; state?: CancellationState; label?: string }) {
  const [requested, setRequested] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const request = async () => {
    setPending(true); setError(undefined);
    try { const result = await desktopApi.cancelOperation(operationId); setRequested(result.requested); }
    catch (value) { setError(errorText(value)); }
    finally { setPending(false); }
  };
  if (state?.phase === "finishing") return <p role="status">Finishing safely…</p>;
  return <div className="operation-cancellation">
    <button data-focusable className="small-control" disabled={pending || requested || state?.requested} onClick={() => { void request(); }}>{requested || state?.requested ? "Cancellation requested" : pending ? "Requesting cancellation…" : label}</button>
    {(requested || state?.requested) && <p role="status">Waiting for the current preparation step to stop safely.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
