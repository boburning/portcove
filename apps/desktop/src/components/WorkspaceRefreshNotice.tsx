import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { focusAndReveal, focusRegion } from "../focus";
import { errorText, failurePresentation } from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { Icon } from "./ui";

export function WorkspaceRefreshNotice({ failure, hasSnapshot, refreshing, retry }: {
  failure?: { error: unknown }; hasSnapshot: boolean; refreshing: boolean; retry: () => Promise<void>;
}) {
  const retryButton = useRef<HTMLButtonElement>(null);
  const retryRequested = useRef(false);
  useEffect(() => {
    if (refreshing || !retryRequested.current) return;
    retryRequested.current = false;
    if (document.activeElement !== document.body) return;
    if (failure) focusAndReveal(retryButton.current);
    else focusRegion("workspace");
  }, [failure, refreshing]);
  if (!failure) return null;
  const { error } = failure;
  const presentation = failurePresentation(error);
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  return <section className="error-banner" role="alert" aria-busy={refreshing}>
    <span className="error-icon"><Icon glyph={AlertTriangle} /></span>
    <div><strong>{hasSnapshot ? "Library information could not be refreshed" : "Library information could not be loaded"}</strong>
      <p>{hasSnapshot ? "Showing the last loaded information. It may be out of date." : "Portcove has not loaded the library information yet."}</p>
      <p>{errorText(error)}</p>
      {presentation && <FailureDetails presentation={presentation} code={code} />}
      <p>Retry refresh loads the current information. It does not repeat your last install, move, or other action.</p>
      <button ref={retryButton} data-focusable disabled={refreshing} onClick={() => { retryRequested.current = true; void retry(); }}>{refreshing ? "Refreshing library…" : "Retry refresh"}</button>
    </div>
  </section>;
}
