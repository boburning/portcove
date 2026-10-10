import { useLayoutEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";
import type { DesktopError } from "../types";
import type { FailureDisplay } from "../view-model";
import { Button } from "./ui/button";

type Presentation = DesktopError["presentation"];

const outcomes: Record<Presentation["mutation_state"], string> = {
  not_started: "This operation did not start.",
  no_changes: "No files were changed by this operation.",
  committed: "The change was saved. Check the result before trying again.",
  recovery_required:
    "An earlier attempt left unfinished work. Review recovery options before trying again.",
  unknown:
    "Portcove couldn't confirm whether anything changed. Check the result before trying again.",
};

export function FailureDetails({
  presentation,
  code,
  contextLabel,
  showMutationSummary = true,
}: {
  presentation: FailureDisplay;
  code?: string;
  contextLabel?: (key: string) => string | undefined;
  showMutationSummary?: boolean;
}) {
  const technical = JSON.stringify(
    {
      code,
      mutation_state: presentation.mutation_state,
      phase: presentation.phase,
      message: presentation.technical_message,
      context: presentation.technical_context,
    },
    null,
    2,
  );
  return (
    <div className="failure-details">
      {showMutationSummary && (
        <p>
          {Object.hasOwn(outcomes, presentation.mutation_state)
            ? outcomes[presentation.mutation_state as Presentation["mutation_state"]]
            : outcomes.unknown}
        </p>
      )}
      <details>
        <summary data-focusable>View technical details</summary>
        {contextLabel ? (
          <dl>
            {code && (
              <div>
                <dt>Error code</dt>
                <dd>{code}</dd>
              </div>
            )}
            <div>
              <dt>Outcome</dt>
              <dd>{presentation.mutation_state}</dd>
            </div>
            {presentation.phase && (
              <div>
                <dt>Phase</dt>
                <dd>{presentation.phase}</dd>
              </div>
            )}
            <div>
              <dt>Message</dt>
              <dd>{presentation.technical_message}</dd>
            </div>
            {Object.entries(presentation.technical_context).map(([key, value]) => {
              const label = contextLabel(key);
              return (
                <div key={key}>
                  <dt>{label ?? <code>{key}</code>}</dt>
                  <dd>{value}</dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <pre>{technical}</pre>
        )}
        <FailureDetailsCopy key={technical} technical={technical} />
      </details>
    </div>
  );
}

function FailureDetailsCopy({ technical }: { technical: string }) {
  const [copyOutcome, setCopyOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const request = useRef(0);
  useLayoutEffect(() => {
    return () => {
      request.current += 1;
    };
  }, []);
  return (
    <>
      <Button
        data-focusable
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => {
          const current = ++request.current;
          setCopyOutcome("idle");
          void copyText(technical)
            .then(() => {
              if (request.current === current) setCopyOutcome("copied");
            })
            .catch(() => {
              if (request.current === current) setCopyOutcome("failed");
            });
        }}
      >
        {copyOutcome === "copied" ? "Copied" : "Copy technical details"}
      </Button>
      {copyOutcome === "copied" && <p role="status">Technical details copied.</p>}
      {copyOutcome === "failed" && (
        <>
          <p role="alert">Clipboard unavailable. Select and copy the technical details below.</p>
          <textarea
            readOnly
            className="mt-2 min-h-20 w-full"
            aria-label="Technical details for manual copy"
            value={technical}
          />
        </>
      )}
    </>
  );
}
