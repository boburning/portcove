import { useState } from "react";
import { copyText } from "../clipboard";
import type { DesktopError } from "../types";
import type { FailureDisplay } from "../view-model";
import { Button } from "./ui/button";

type Presentation = DesktopError["presentation"];

const outcomes: Record<Presentation["mutation_state"], string> = {
  not_started: "This operation did not start.",
  no_changes: "No files were changed by this operation.",
  committed: "The change was committed. Review the current state before another operation.",
  recovery_required: "Retained work needs recovery review before another attempt.",
  unknown: "The changes could not be confirmed. Review the current state before another attempt.",
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
  const [copied, setCopied] = useState(false);
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
        <Button
          data-focusable
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => {
            void copyText(technical)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy technical details"}
        </Button>
      </details>
    </div>
  );
}
