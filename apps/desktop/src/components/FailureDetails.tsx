import { useState } from "react";
import { copyText } from "../clipboard";
import type { DesktopError } from "../types";
import type { FailureDisplay } from "../view-model";

type Presentation = DesktopError["presentation"];

const outcomes: Record<Presentation["mutation_state"], string> = {
  not_started: "This operation did not start.",
  no_changes: "No files were changed by this operation.",
  committed:
    "The change was committed. Review the current state before another operation.",
  recovery_required:
    "Retained work needs recovery review before another attempt.",
  unknown:
    "The changes could not be confirmed. Review the current state before another attempt.",
};

export function FailureDetails({
  presentation,
  code,
}: {
  presentation: FailureDisplay;
  code?: string;
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
      <p>
        {Object.hasOwn(outcomes, presentation.mutation_state)
          ? outcomes[
              presentation.mutation_state as Presentation["mutation_state"]
            ]
          : outcomes.unknown}
      </p>
      <details>
        <summary data-focusable>View technical details</summary>
        <pre>{technical}</pre>
        <button
          data-focusable
          onClick={() => {
            void copyText(technical)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy technical details"}
        </button>
      </details>
    </div>
  );
}
