import type { SourceInspectionReport, SourceProfile, SourceRecord } from "../types";
import type { ReactNode } from "react";
import { Button } from "./ui/button";

type Inspection = NonNullable<SourceInspectionReport["inspection"]>;

export function preliminarySelectionRecord(selection: Inspection) {
  const { assessment, validator, record } = selection;
  return assessment.admission.state === "admitted" &&
    assessment.admission.mode === "structural_checks" &&
    assessment.classification.state === "not_evaluated" &&
    assessment.contract.state === "not_evaluated" &&
    validator?.result === "not_run" &&
    Boolean(validator.contract_id && validator.tool_id && validator.protocol_version) &&
    record?.profile_id === selection.profile_id &&
    record.path === selection.path
    ? record
    : undefined;
}

export function PreliminarySourceSelections({
  selections = [],
  profiles,
  disabled,
  onReview,
  renderActions,
  headingLevel = 3,
}: {
  selections?: Inspection[] | undefined;
  profiles: SourceProfile[];
  disabled: boolean;
  onReview: (candidate: Pick<SourceRecord, "profile_id" | "path">) => void;
  renderActions?: (candidate: SourceRecord) => ReactNode;
  headingLevel?: 3 | 4;
}) {
  if (selections.length === 0) return null;
  const Heading = headingLevel === 4 ? "h4" : "h3";
  return (
    <section aria-label="Preliminary game-file selections">
      <Heading>Preliminary selections</Heading>
      <p>
        These files are not exact matches. Validation has not run, and compatibility is not
        confirmed. Review a selection before deciding whether to save its location.
      </p>
      {selections.map((selection) => {
        const candidate = preliminarySelectionRecord(selection);
        const profile = profiles.find((item) => item.id === selection.profile_id);
        return (
          <div
            data-preliminary-selection
            data-profile-id={selection.profile_id}
            data-path={selection.path}
            className="source-health-row my-2 rounded-pc-md border border-pc-border p-3"
            key={`${selection.profile_id}:${selection.path}`}
          >
            <strong>{profile?.label ?? selection.profile_id}</strong>
            <code className="block whitespace-normal [overflow-wrap:anywhere]">
              {selection.path}
            </code>
            <p>
              {candidate
                ? "Validation has not run."
                : "Selection details are unavailable or inconsistent. Search again before reviewing this file."}
            </p>
            {candidate && profile && renderActions ? (
              renderActions(candidate)
            ) : (
              <Button
                data-focusable
                data-candidate-review
                variant="outline"
                disabled={disabled || !candidate || !profile}
                onClick={() => {
                  if (candidate && profile) onReview(candidate);
                }}
              >
                Review preliminary selection
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}
