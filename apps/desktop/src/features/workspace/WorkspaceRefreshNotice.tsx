import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { focusAndReveal, focusRegion } from "../../focus";
import { errorText, failurePresentation } from "../../view-model";
import { FailureDetails } from "../../components/FailureDetails";
import { Icon } from "../../components/ui";
import { Button } from "../../components/ui/button";

export function WorkspaceRefreshNotice({
  failure,
  recoveryFailure,
  hasSnapshot,
  refreshing,
  retry,
  retryRecovery,
  subscriptionFailure,
}: {
  failure?: { error: unknown };
  recoveryFailure?: { error: unknown };
  hasSnapshot: boolean;
  refreshing: boolean;
  retry: () => Promise<void>;
  retryRecovery: () => Promise<void>;
  subscriptionFailure?: unknown;
}) {
  const retryButton = useRef<HTMLButtonElement>(null);
  const recoveryRetryButton = useRef<HTMLButtonElement>(null);
  const retryRequested = useRef(false);
  useEffect(() => {
    if (refreshing || !retryRequested.current) return;
    retryRequested.current = false;
    if (document.activeElement !== document.body) return;
    if (failure) focusAndReveal(retryButton.current);
    else if (recoveryFailure) focusAndReveal(recoveryRetryButton.current);
    else focusRegion("workspace");
  }, [failure, recoveryFailure, refreshing]);
  if (!failure && !recoveryFailure && !subscriptionFailure) return null;
  if (!failure && recoveryFailure)
    return (
      <section className="error-banner" role="alert" aria-busy={refreshing}>
        <span className="error-icon">
          <Icon glyph={AlertTriangle} />
        </span>
        <div>
          <strong>Library recovery could not finish</strong>
          <p>
            Current library information is available, but some unfinished work still needs review.
          </p>
          <p>{errorText(recoveryFailure.error)}</p>
          <Button
            ref={recoveryRetryButton}
            variant="outline"
            data-focusable
            disabled={refreshing}
            onClick={() => {
              retryRequested.current = true;
              void retryRecovery();
            }}
          >
            Retry recovery
          </Button>
        </div>
      </section>
    );
  if (!failure)
    return (
      <section className="error-banner" role="status" aria-busy={refreshing}>
        <span className="error-icon">
          <Icon glyph={AlertTriangle} />
        </span>
        <div>
          <strong>Live workspace updates are unavailable</strong>
          <p>
            Portcove will keep checking activity at a reduced rate. Refresh manually after library
            changes until the desktop is restarted.
          </p>
          <Button
            variant="outline"
            data-focusable
            disabled={refreshing}
            onClick={() => void retry()}
          >
            {refreshing ? "Refreshing library…" : "Refresh now"}
          </Button>
        </div>
      </section>
    );
  const { error } = failure;
  const presentation = failurePresentation(error);
  const consequentialOutcome =
    presentation?.mutation_state === "committed" ||
    presentation?.mutation_state === "recovery_required";
  const code =
    typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  return (
    <section className="error-banner" role="alert" aria-busy={refreshing}>
      <span className="error-icon">
        <Icon glyph={AlertTriangle} />
      </span>
      <div>
        <strong>
          {hasSnapshot
            ? "Library information could not be refreshed"
            : "Library information could not be loaded"}
        </strong>
        <p>
          {hasSnapshot
            ? "Showing the last loaded information. It may be out of date."
            : "Portcove has not loaded the library information yet."}
        </p>
        <p>{errorText(error)}</p>
        {presentation && (
          <FailureDetails
            presentation={presentation}
            code={code}
            showMutationSummary={consequentialOutcome}
          />
        )}
        <p>
          {hasSnapshot
            ? "Retry refresh loads the current information. It does not repeat your last install, move, or other action."
            : "Retry refresh loads the library information. It does not install, move, or change a game."}
        </p>
        <Button
          ref={retryButton}
          variant="outline"
          data-focusable
          disabled={refreshing}
          onClick={() => {
            retryRequested.current = true;
            void retry();
          }}
        >
          {refreshing ? "Refreshing library…" : "Retry refresh"}
        </Button>
      </div>
    </section>
  );
}
