import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import { MetadataGrid } from "./ui/patterns";
import type { PortDefinition, SourceInspectionReport } from "../types";
import type { SourceEvidence, SourceVariant } from "../transport-types.generated";
import { platformLabel } from "../view-model";

/** Unknown Core values fall back to explicit unknown labels. */
function kindLabel(t: TFunction<"gameFiles">, kind: string): string {
  switch (kind) {
    case "structural_check":
      return t("testResults.kind.structural");
    case "automated_lifecycle":
      return t("testResults.kind.automated");
    case "hands_on":
      return t("testResults.kind.handsOn");
    case "known_failure":
      return t("testResults.kind.knownFailure");
    default:
      return t("testResults.kind.unknown");
  }
}

function outcomeLabel(t: TFunction<"gameFiles">, outcome: string): string {
  switch (outcome) {
    case "passed":
      return t("testResults.outcome.passed");
    case "failed":
      return t("testResults.outcome.failed");
    case "not_run":
      return t("testResults.outcome.notRun");
    default:
      return t("testResults.outcome.unknown");
  }
}

function sectionLabel(
  t: TFunction<"gameFiles">,
  technical: boolean,
  role: "game" | "bios",
): string {
  if (technical)
    return role === "game"
      ? t("testResults.section.technicalGame")
      : t("testResults.section.technicalBios");
  return role === "game" ? t("testResults.section.game") : t("testResults.section.bios");
}

export function DetailQualificationSummary({
  port,
  sourceInspection,
  biosInspection,
  technical = false,
}: {
  port: PortDefinition;
  sourceInspection?: SourceInspectionReport | undefined;
  biosInspection?: SourceInspectionReport | undefined;
  technical?: boolean;
}) {
  const { t } = useAppTranslation("gameFiles");
  return (
    <>
      {!technical && (
        <div className="metadata grid grid-cols-[1fr_1fr] gap-[10px]">
          <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
            <small className="mb-[5px] block text-[var(--color-text-muted)]">
              {t("testResults.earlierAutomated")}
            </small>
            {legacyCoverage(t, port.platforms, port.automated_tested_platforms)}
          </span>
          <span className="min-w-0 rounded-pc-md bg-[var(--color-bg-subtle)] p-[12px] text-[length:var(--text-xs)] [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
            <small className="mb-[5px] block text-[var(--color-text-muted)]">
              {t("testResults.earlierHandsOn")}
            </small>
            {legacyCoverage(t, port.platforms, port.manually_validated_platforms)}
          </span>
        </div>
      )}
      {!technical && (
        <p className="text-sm text-pc-muted-foreground">{t("testResults.earlierNote")}</p>
      )}
      {(["game", "bios"] as const).map((role) => {
        const profile = role === "game" ? port.source_profile : port.bios_source_profile;
        if (!profile) return null;
        const report = role === "game" ? sourceInspection : biosInspection;
        const application =
          report?.profile_id === profile
            ? report.applications.find(
                (candidate) =>
                  candidate.port_id === port.id &&
                  candidate.role === role &&
                  candidate.contract.port_id === port.id &&
                  candidate.contract.role === role &&
                  candidate.contract.profile_id === profile,
              )
            : undefined;
        const records = application?.qualification.exact_records.filter((record) => {
          if (
            record.scope.port_id !== port.id ||
            record.scope.contract_id !== application.contract.id
          )
            return false;
          if (record.scope.variant.state !== "exact") return true;
          const identity = record.scope.variant.identity;
          const variant =
            report?.expected_identity?.id === profile
              ? report.expected_identity.variants.find(
                  (candidate) =>
                    candidate.id === identity.variant_id && !candidate.legacy_projection_only,
                )
              : undefined;
          return (
            identity.game_id === profile &&
            application.contract.supported_variant_ids.includes(identity.variant_id) &&
            !!variant?.representations.some(
              (representation) => representation.id === identity.representation_id,
            )
          );
        });
        return (
          <section key={role} aria-label={sectionLabel(t, technical, role)}>
            <h3 className="text-sm font-medium">
              {role === "game" ? t("testResults.heading.game") : t("testResults.heading.bios")}
            </h3>
            {!application ? (
              <p>{t("testResults.reportUnavailable")}</p>
            ) : (
              <>
                {records?.length ? (
                  <ul className="grid gap-3">
                    {records.map((record, index) => (
                      <li key={index}>
                        <RecordedObservation
                          record={record}
                          technical={technical}
                          variants={report?.expected_identity?.variants ?? []}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("testResults.noRecords")}</p>
                )}
                {records?.length !== application.qualification.exact_records.length && (
                  <p>{t("testResults.unverifiedScopes")}</p>
                )}
              </>
            )}
            <p className="text-sm text-pc-muted-foreground">{t("testResults.notConfirmed")}</p>
          </section>
        );
      })}
    </>
  );
}

function RecordedObservation({
  record,
  technical,
  variants,
}: {
  record: SourceEvidence;
  technical: boolean;
  variants: SourceVariant[];
}) {
  const { t } = useAppTranslation("gameFiles");
  const identity =
    record.scope.variant.state === "exact" ? record.scope.variant.identity : undefined;
  const edition = recordedEdition(record, variants) ?? t("testResults.notRecorded");
  const notRecorded = t("testResults.notRecorded");
  const observedAt = new Date(record.observed_at * 1000);
  return (
    <div className="grid gap-1 text-sm break-words">
      <strong>
        {t("testResults.kindOutcome", {
          kind: kindLabel(t, record.kind),
          outcome: outcomeLabel(t, record.outcome),
        })}
      </strong>
      <p>{record.method || t("testResults.methodNotRecorded")}</p>
      <MetadataGrid className="qualification-grid max-[760px]:grid-cols-[1fr]">
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt>{t("testResults.field.platform")}</dt>
          <dd>{platformLabel(record.scope.platform)}</dd>
        </div>
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt>{t("testResults.field.observed")}</dt>
          <dd>
            {Number.isNaN(observedAt.getTime())
              ? notRecorded
              : observedAt.toISOString().slice(0, 10)}
          </dd>
        </div>
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt>{t("testResults.field.edition")}</dt>
          <dd>
            {technical && identity
              ? `${identity.game_id} · ${identity.variant_id} · ${identity.representation_id}`
              : edition}
          </dd>
        </div>
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt>{t("testResults.field.release")}</dt>
          <dd>{record.scope.upstream_ref || notRecorded}</dd>
        </div>
        {technical && (
          <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
            <dt>{t("testResults.field.contract")}</dt>
            <dd>{record.scope.contract_id || notRecorded}</dd>
          </div>
        )}
        {technical && (
          <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
            <dt>{t("testResults.field.checkVersion")}</dt>
            <dd>{record.scope.check_version || notRecorded}</dd>
          </div>
        )}
        {technical && (
          <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
            <dt>{t("testResults.field.artifact")}</dt>
            <dd>
              <code className="break-all">{record.scope.artifact_sha256 || notRecorded}</code>
            </dd>
          </div>
        )}
      </MetadataGrid>
      {!technical && (
        <p>
          {record.scope.check_version && record.scope.artifact_sha256
            ? t("testResults.detailsAvailable")
            : t("testResults.detailsMissing")}
        </p>
      )}
    </div>
  );
}

function recordedEdition(record: SourceEvidence, variants: SourceVariant[]) {
  const identity =
    record.scope.variant.state === "exact" ? record.scope.variant.identity : undefined;
  const variant = variants.find((candidate) => candidate.id === identity?.variant_id);
  const representation = variant?.representations.find(
    (candidate) => candidate.id === identity?.representation_id,
  );
  const edition =
    variant && representation
      ? [
          variant.title,
          variant.region,
          variant.revision,
          representation.extensions.map((extension) => `.${extension}`).join(", "),
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;
  return edition;
}

function legacyCoverage(
  t: TFunction<"gameFiles">,
  supported: PortDefinition["platforms"],
  completed: PortDefinition["platforms"],
): ReactNode {
  const completedSet = new Set(completed);
  const recorded = supported.filter((platform) => completedSet.has(platform));
  if (recorded.length === 0) return t("testResults.noEarlierTests");
  const unrecorded = supported.filter((platform) => !completedSet.has(platform));
  // Platform labels are shared view-model data joined as a list.
  const completedLabel = recorded.map((platform) => platformLabel(platform)).join(" · ");
  if (unrecorded.length === 0) return completedLabel;
  return (
    <Trans
      t={t}
      i18nKey="testResults.partialCoverage"
      components={{
        recorded: <>{completedLabel}</>,
        missing: <>{unrecorded.map((platform) => platformLabel(platform)).join(" · ")}</>,
      }}
    />
  );
}
