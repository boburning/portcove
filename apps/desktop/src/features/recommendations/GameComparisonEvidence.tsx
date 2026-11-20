import { useAppTranslation } from "../../localization";
import { useId, useState } from "react";
import { platforms } from "../../catalog-values.generated";
import { platformLabel, releaseChannelPresentation } from "../../view-model";
import { ChoiceSelect } from "../../components/ChoiceSelect";
import { Button } from "../../components/ui/button";
import { Chip } from "../../components/ui/chip";
import { ExternalLink } from "../../components/ExternalLink";
import { controlFocus } from "../../components/ui/control-style";
import type { GameComparison } from "../../types";
import type { Organization } from "../organization/OrganizationControls";
import type { useGameComparison } from "./use-game-comparison";

type Comparison = ReturnType<typeof useGameComparison>;
type Assessment = NonNullable<GameComparison["assessment"]>;
type Candidate = Assessment["candidates"][number];
type Reason = Candidate["reasons"][number];
type Evidence = Assessment["candidates"][number]["evidence"][number];
const reportKinds: Record<Evidence["evidence"]["kind"], string> = {
  "upstream-declared": "Reported by the project",
  "artifact-inspected": "Download inspection",
  "setup-observed": "Setup report",
  "launch-observed": "Launch report",
  "gameplay-observed": "Gameplay report",
  "performance-observed": "Performance report",
  "maintenance-observed": "Maintenance report",
};
const reportStates: Record<Evidence["disposition"], string> = {
  current: "Applies to the selected options",
  "historical-scope": "For a different game, version or setup",
  "future-observation": "Dated after this comparison",
  "unsupported-observation-kind": "This report type isn’t supported",
  superseded: "Replaced by a newer report",
  invalid: "This report couldn’t be checked",
};
const dimensionStates: Record<
  Assessment["candidates"][number]["dimensions"][number]["state"],
  string
> = {
  known: "Information available",
  unknown: "Not enough information",
  "not-applicable": "Doesn’t apply",
  conflicting: "Reports disagree",
};
const reasons: Record<Reason, string> = {
  "different-game-or-edition":
    "This port uses a different game edition. You may need different original files.",
  "different-platform-or-environment": "This information is for a different platform or setup.",
  "source-not-selected": "The required original game files are not selected.",
  "operation-unknown":
    "This comparison couldn’t confirm the operation for the selected options. Open the port to check its current status.",
  "operation-held": "This action isn’t available right now.",
  "requirement-unknown": "We couldn’t confirm a feature you need for this game version.",
  "requirement-unsupported": "A feature you need is listed as unsupported for this version.",
  "invalid-evidence": "Some information can’t be matched to an exact game version or setup.",
  "conflicting-evidence": "The available reports disagree, so we can’t suggest one port.",
  "critical-regression": "A reported gameplay or save problem is still unresolved for this setup.",
  "insufficient-coverage": "We don’t have enough relevant information to suggest this port.",
  "gameplay-unobserved": "Gameplay hasn’t been confirmed for this exact game version.",
  "stability-unobserved":
    "Stability and save reliability haven’t been confirmed for this exact game version.",
  "gameplay-below-default-floor": "Gameplay limitations are reported.",
  "stability-below-default-floor": "Stability or save problems are reported.",
  "materially-worse-playing-experience":
    "Another available port has stronger gameplay information.",
};
const dimensions = {
  gameplay: "Gameplay",
  stability: "Stability and saves",
  performance: "Performance",
  controls: "Controls and capabilities",
  setup: "Setup and updates",
  maintenance: "Maintenance outlook",
};
const comparisonFeatures = [
  { id: "multiplayer", label: "Multiplayer" },
  { id: "controller", label: "Controller support" },
];
const requirementStates: Record<Candidate["required_capabilities"][string], string> = {
  satisfied: "Supported for these options",
  unknown: "Support unconfirmed",
  unsupported: "Unsupported for these options",
};
const decisionReasons: ReadonlySet<Reason> = new Set([
  "different-game-or-edition",
  "different-platform-or-environment",
  "source-not-selected",
  "conflicting-evidence",
  "critical-regression",
  "gameplay-below-default-floor",
  "stability-below-default-floor",
]);
const statuses: Record<Exclude<Assessment["status"], "recommended-starting-point">, string> = {
  "comparable-alternatives":
    "These options are worth considering. We don’t have enough information to prefer one.",
  "assessed-single-candidate":
    "Only one port has been assessed, so there isn’t enough information to compare it with the others.",
  "insufficient-evidence":
    "We don’t have enough information to suggest a port. You can still explore every project.",
  "no-suitable-candidate":
    "None of the assessed ports meets the options you selected. Open a project to check its setup and available actions.",
};
function time(value: number | null | undefined) {
  if (value === undefined || value === null) return "Not observed";
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "Outside displayable date range";
}

export function GameComparisonControls({ comparison }: { comparison: Comparison }) {
  const { report, context, setContext } = comparison;
  const assessment = report?.assessment;
  const suggested =
    assessment?.status === "recommended-starting-point"
      ? report?.ports.find((port) => port.port_id === assessment.recommended?.port_id)
      : undefined;
  const edition = report?.editions.find(
    (item) => item.id === (context.edition || report.edition_id),
  );
  const platform = context.platform || report?.platform;
  const selectedFeatures = comparisonFeatures.filter(({ id }) => context.requirements.includes(id));
  const environments = [
    ...new Set(
      report?.assessment?.candidates.flatMap((candidate) =>
        candidate.evidence.map((record) => record.evidence.scope.environment_id),
      ) ?? [],
    ),
  ].sort();
  const updateRequirement = (id: string, checked: boolean) =>
    setContext((current) => ({
      ...current,
      requirements: checked
        ? [...new Set([...current.requirements, id])].sort()
        : current.requirements.filter((requirement) => requirement !== id),
    }));
  return (
    <section className="comparison-context" aria-label="Comparison options" data-focus-group>
      <header className="comparison-context-heading">
        <h3 className="sr-only">Compare these ports</h3>
        {comparison.enabled && (
          <p className="text-sm">
            {report && !edition && report.editions.length > 1 && !context.edition ? (
              <>
                Choose a game edition to compare. Target platform: {platformLabel(report.platform)}.
              </>
            ) : (
              <>
                Comparing {edition ? <bdi>{edition.title}</bdi> : "the selected game"} on{" "}
                {platform ? platformLabel(platform) : "this device"}.
              </>
            )}{" "}
            {context.environment ? (
              <>
                Using reports for <bdi>{context.environment}</bdi>.
              </>
            ) : (
              "Device-specific test results may be unavailable."
            )}
          </p>
        )}
      </header>
      {comparison.enabled && (
        <div className="comparison-context-heading">
          <p role="status" aria-live="polite" className="text-sm">
            {comparison.loading ? (
              "Refreshing the selected comparison…"
            ) : comparison.failed ? (
              "We couldn’t load this comparison. You can still open each project’s details and available actions."
            ) : suggested ? (
              <>
                <strong>Suggested starting point</strong> · <bdi>{suggested.name}</bdi>
              </>
            ) : assessment && assessment.status !== "recommended-starting-point" ? (
              statuses[assessment.status]
            ) : (
              "We don’t have a recommendation for these options yet. You can still explore each project."
            )}
          </p>
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={comparison.loading}
            onClick={() => void comparison.refresh()}
          >
            Refresh version information
          </Button>
        </div>
      )}
      {selectedFeatures.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Required features</span>
          {selectedFeatures.map(({ id, label }) => (
            <Chip key={id}>{label}</Chip>
          ))}
        </div>
      )}
      {comparison.enabled && (
        <p className="text-xs text-pc-muted-foreground">
          Refreshing checks version information. It doesn’t run the game or test your device.
        </p>
      )}
      {!comparison.enabled ? (
        <p role="status">
          Comparison isn’t available in this view. You can still open each project’s details and
          available actions.
        </p>
      ) : (
        <>
          <details className="comparison-settings">
            <summary data-focusable className={controlFocus}>
              Comparison settings
            </summary>
            {report?.limitations.map((limitation) => (
              <p key={limitation} className="text-xs text-pc-muted-foreground">
                {limitation}
              </p>
            ))}

            <p className="text-sm text-pc-muted-foreground">
              Choose a game edition, platform and features to compare. Setup and Play availability
              is shown in the project’s details.
            </p>
            <div className="flex flex-wrap gap-3">
              <ChoiceSelect
                label="Game edition"
                value={context.edition || "automatic"}
                options={[
                  { value: "automatic", label: "Automatic, when unambiguous" },
                  ...(report?.editions.map((edition) => ({
                    value: edition.id,
                    label: edition.title,
                  })) ?? []),
                ]}
                onChange={(edition) =>
                  setContext((current) => ({
                    ...current,
                    edition: edition === "automatic" ? "" : edition,
                  }))
                }
              />
              <ChoiceSelect
                label="Target platform"
                value={context.platform || "current"}
                options={[
                  { value: "current", label: "Current device" },
                  ...platforms.map((platform) => ({
                    value: platform,
                    label: platformLabel(platform),
                  })),
                ]}
                onChange={(platform) =>
                  setContext((current) => ({
                    ...current,
                    platform: platform === "current" ? "" : platform,
                  }))
                }
              />
              {environments.length > 0 && (
                <ChoiceSelect
                  label="Platform and setup used in the report"
                  value={context.environment || "current"}
                  description="Choose a recorded setup to see its reports. Your device may differ."
                  options={[
                    { value: "current", label: "This device — test results unconfirmed" },
                    ...environments.map((environment) => ({
                      value: environment,
                      label: environment,
                    })),
                  ]}
                  onChange={(environment) =>
                    setContext((current) => ({
                      ...current,
                      environment: environment === "current" ? "" : environment,
                    }))
                  }
                />
              )}
            </div>
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend>Features you need</legend>
              {comparisonFeatures.map(({ id, label }) => (
                <label key={id} className="inline-flex items-center gap-2">
                  <input
                    data-focusable
                    type="checkbox"
                    className={controlFocus}
                    checked={context.requirements.includes(id)}
                    onChange={(event) => updateRequirement(id, event.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            <p className="text-xs text-pc-muted-foreground">
              Recognized game files don’t confirm that a game works on your device. Portcove may use
              saved version information. Turn on update notices for a port to see when Portcove
              finds a new download.
            </p>
          </details>
        </>
      )}
    </section>
  );
}

export function GameComparisonEvidence({
  comparison,
  portId,
  organization,
}: {
  comparison: Comparison;
  portId: string;
  organization: Organization | undefined;
}) {
  const { t } = useAppTranslation("organization");
  const noticeDescriptionId = useId();
  const disclosureScope = JSON.stringify([comparison.scopeBinding, portId]);
  const [disclosure, setDisclosure] = useState({ scope: disclosureScope, open: false });
  const report = comparison.report;
  if (!report) return null;
  const port = report.ports.find((row) => row.port_id === portId);
  if (!port) return null;
  const candidate = report.assessment?.candidates.find(
    (candidate) => candidate.scope.port_id === portId,
  );
  const recommendationAssessment = comparison.loading ? undefined : report.assessment;
  const recommended =
    recommendationAssessment?.status === "recommended-starting-point" &&
    recommendationAssessment.recommended?.port_id === portId;
  const featureResults =
    !candidate ||
    candidate.scope.game_id !== report.game_id ||
    candidate.scope.edition_id !== report.edition_id ||
    candidate.scope.platform !== report.platform ||
    candidate.scope.environment_id !== report.environment_id
      ? undefined
      : candidate.required_capabilities;
  const requiredFeatures = comparisonFeatures.filter(({ id }) =>
    report.required_capabilities.includes(id),
  );
  const retainedVersion =
    port.freshness.state === "definition-changed" || port.freshness.state === "collection-failed";
  const followed = organization?.snapshot?.followed_port_ids.includes(portId) ?? false;
  return (
    <section
      className="mt-3 space-y-2 border-t border-pc-border pt-3"
      aria-label={`Reports and updates for ${port.name}`}
      data-focus-group
    >
      {recommended && <Chip>Suggested starting point</Chip>}
      {recommendationAssessment?.status === "comparable-alternatives" &&
        recommendationAssessment.comparable.some((scope) => scope.port_id === portId) && (
          <Chip>Comparable option</Chip>
        )}
      <p className="text-xs text-pc-muted-foreground">
        {port.offered_release
          ? `${retainedVersion ? "Last recorded version" : "Offered version"} ${port.offered_release.version}`
          : "No confirmed version for this comparison."}
      </p>
      {!comparison.loading && (
        <div className="grid gap-2 text-sm">
          {port.operation.kind !== "allowed" && <p>{port.operation.reason}</p>}
          {candidate?.reasons
            .filter((reason) => decisionReasons.has(reason))
            .map((reason) => (
              <p key={reason}>{reasons[reason]}</p>
            ))}
          {requiredFeatures.length > 0 && (
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2">
              {requiredFeatures.map(({ id, label }) => (
                <div key={id}>
                  <dt className="font-medium">{label}</dt>
                  <dd>{requirementStates[featureResults?.[id] ?? "unknown"]}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      <details
        open={disclosure.scope === disclosureScope && disclosure.open}
        onToggle={(event) =>
          setDisclosure({ scope: disclosureScope, open: event.currentTarget.open })
        }
      >
        <summary data-focusable className={`cursor-pointer text-sm font-medium ${controlFocus}`}>
          {candidate ? "Why this port?" : "Reports and updates"} — {port.name}
        </summary>
        <div className="mt-2 space-y-2 text-xs">
          <p className="text-pc-muted-foreground">
            {port.freshness.state === "catalog-pinned"
              ? "This comparison uses the version pinned in the catalog."
              : `Last checked successfully: ${time(port.freshness.last_successful_resolution_at)}. Latest observation: ${port.freshness.state}.`}
          </p>
          {port.limitations.map((limitation) => (
            <p key={limitation}>{limitation}</p>
          ))}
          {candidate ? (
            <>
              {candidate.reasons
                .filter((reason) => !decisionReasons.has(reason))
                .map((reason) => (
                  <p key={reason}>{reasons[reason]}</p>
                ))}
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                {candidate.dimensions.map((dimension) => (
                  <div key={dimension.dimension}>
                    <dt className="font-medium">{dimensions[dimension.dimension]}</dt>
                    <dd>
                      {dimension.state === "known" &&
                      (dimension.dimension === "controls" || dimension.dimension === "setup")
                        ? candidate.evidence.find(
                            (record) =>
                              record.disposition === "current" &&
                              record.evidence.dimension === dimension.dimension,
                          )?.evidence.explanation || dimensionStates.known
                        : dimensionStates[dimension.state]}
                    </dd>
                  </div>
                ))}
              </dl>
              {candidate.evidence.map((record, index) => (
                <div
                  key={`${record.evidence.id}-${index}`}
                  className="rounded-pc-sm border border-pc-border p-2 wrap-anywhere"
                >
                  <p className="font-medium">
                    {dimensions[record.evidence.dimension]} · {reportKinds[record.evidence.kind]} ·{" "}
                    {reportStates[record.disposition]}
                  </p>
                  <p>{record.evidence.explanation}</p>
                  <p>
                    Reported {time(record.evidence.observed_at)} · Version{" "}
                    {record.evidence.scope.release_id} ·{" "}
                    {platformLabel(record.evidence.scope.platform)}.
                  </p>
                  <details>
                    <summary data-focusable className={controlFocus}>
                      Technical details
                    </summary>
                    <p>Download identity: {record.evidence.scope.artifact_id}</p>
                    <p>Report setup: {record.evidence.scope.environment_id}</p>
                  </details>
                  <ExternalLink href={record.evidence.source}>Read the source</ExternalLink>
                </div>
              ))}
              <p>
                Reports cover their listed version and setup. They don’t confirm successful play on
                your device.
              </p>
            </>
          ) : (
            <p>
              No comparison is available for this edition and download. You can still explore the
              project.
            </p>
          )}
          <details>
            <summary data-focusable className={controlFocus}>
              Technical details
            </summary>
            <p className="text-xs">
              {port.offered_release
                ? `Offered ${port.offered_release.version} · ${releaseChannelPresentation(port.offered_release.channel).label} · SHA-256 ${port.offered_release.artifact_sha256.slice(0, 12)}`
                : "We couldn’t confirm a download for this comparison."}
            </p>
            {port.offered_release?.published_at && (
              <p className="text-xs text-pc-muted-foreground">
                Upstream publication time: {port.offered_release.published_at}
              </p>
            )}
            {port.freshness.offered_identity_changed_at !== null && (
              <p className="text-xs text-pc-muted-foreground">
                Offered identity changed in local observations:{" "}
                {time(port.freshness.offered_identity_changed_at)}
              </p>
            )}
            <p className="text-xs">
              Current library: {port.installed ? "installed or registered" : "not installed"};{" "}
              {port.launch_ready
                ? "launch-ready under existing library checks"
                : "launch readiness not established"}
              . This does not qualify the selected evidence environment.
            </p>
            <p className="text-xs">
              Original-file status: {port.source_health ?? "not assessed"}. Required game files:{" "}
              {port.source_profile_ids.join(", ") || "none declared"}.
            </p>

            <p>Comparison policy: {report.policy_version}</p>
          </details>
        </div>
      </details>
      {organization && (
        <div className="flex flex-wrap gap-2">
          <Button
            data-focusable
            size="sm"
            variant={followed ? "selected" : "ghost"}
            aria-pressed={followed}
            aria-describedby={noticeDescriptionId}
            aria-busy={organization.busy}
            focusableWhenDisabled={Boolean(organization.snapshot)}
            disabled={
              !organization.snapshot ||
              organization.busy ||
              Boolean(organization.failure) ||
              comparison.loading
            }
            onClick={() =>
              void organization.commit({
                kind: "set_followed_project",
                port_id: portId,
                followed: !followed,
                observed_identity: port.offered_identity,
              })
            }
          >
            {t("comparisonNotice.label", { port: port.name })}
          </Button>
          <span aria-hidden="true" className="self-center text-sm">
            {followed ? t("comparisonNotice.on") : t("comparisonNotice.off")}
          </span>
          <p id={noticeDescriptionId} className="basis-full text-xs text-pc-muted-foreground">
            {t("comparisonNotice.effect")}
          </p>
          {port.update_notice && followed && (
            <div role="status" className="basis-full text-sm">
              <p>{t("comparisonNotice.available", { version: port.update_notice.version })}</p>
              <Button
                data-focusable
                variant="ghost"
                size="sm"
                disabled={organization.busy}
                onClick={() =>
                  void organization.commit({
                    kind: "acknowledge_followed_release",
                    port_id: portId,
                    identity: port.update_notice!.identity,
                  })
                }
              >
                {t("comparisonNotice.markSeen")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
