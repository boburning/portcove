import { errorText, failurePresentation } from "../view-model";
import { FailureDetails } from "./FailureDetails";

/** Keep Core's reported consequences attached to a failed review or execution. */
export function ActionReviewFailure({ error }: { error: unknown }) {
  if (error === undefined) return null;
  const presentation = failurePresentation(error);
  const neutral =
    presentation?.tone === "neutral" &&
    (presentation.mutation_state === "not_started" || presentation.mutation_state === "no_changes");
  const code =
    typeof error === "object" && error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return (
    <div role={neutral ? "status" : "alert"}>
      <p>{errorText(error)}</p>
      {presentation && <FailureDetails presentation={presentation} code={code} />}
    </div>
  );
}
