import type { SourceInspectionReport, SourceProfile, SourceRecord } from "../types";
import type { ReactNode } from "react";
import { useAppTranslation } from "../localization";
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
  const { t } = useAppTranslation("gameFiles");
  if (selections.length === 0) return null;
  const Heading = headingLevel === 4 ? "h4" : "h3";
  return (
    <section aria-label={t("preliminary.label")}>
      <Heading>{t("preliminary.heading")}</Heading>
      <p>{t("preliminary.description")}</p>
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
            <code dir="ltr" className="block [overflow-wrap:anywhere] whitespace-normal">
              {selection.path}
            </code>
            <p>{candidate ? t("preliminary.notValidated") : t("preliminary.inconsistent")}</p>
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
                {t("preliminary.check")}
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}
