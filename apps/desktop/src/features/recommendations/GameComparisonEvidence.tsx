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
type Reason = Assessment["candidates"][number]["reasons"][number];
const reasons: Record<Reason, string> = {
  "different-game-or-edition":
    "This is a different source edition, not an interchangeable alternative.",
  "different-platform-or-environment": "The selected device context differs from this observation.",
  "source-not-selected": "The required original-file profile is not selected.",
  "operation-unknown": "Existing operation readiness or optional evidence is not established.",
  "operation-held": "An existing Core operation hold applies; a score cannot override it.",
  "requirement-unknown": "A required capability has not been established for this exact build.",
  "requirement-unsupported": "A required capability is not supported in the assessed scope.",
  "invalid-evidence": "Some current evidence is invalid or has ambiguous identities.",
  "conflicting-evidence": "Current evidence disagrees; no default is justified.",
  "critical-regression":
    "An accepted gameplay or save failure remains unresolved for this context.",
  "insufficient-coverage": "There is not enough relevant evidence for a suggested default.",
  "gameplay-unobserved": "Exact-build gameplay has not been established.",
  "stability-unobserved": "Exact-build stability and save reliability have not been established.",
  "gameplay-below-default-floor": "Observed gameplay has material limitations.",
  "stability-below-default-floor":
    "Observed stability or save reliability has material limitations.",
  "materially-worse-playing-experience":
    "Another eligible option has materially stronger playing evidence.",
};
const dimensions = {
  gameplay: "Gameplay",
  stability: "Stability and saves",
  performance: "Performance",
  controls: "Controls and capabilities",
  setup: "Setup and updates",
  maintenance: "Maintenance outlook",
};
const statuses: Record<Assessment["status"], string> = {
  "recommended-starting-point": "A suggested starting point is supported in this selected context.",
  "comparable-alternatives":
    "Comparable alternatives: the evidence does not justify choosing one over the others.",
  "assessed-single-candidate": "One candidate assessed. This is not a best-port claim.",
  "insufficient-evidence":
    "Insufficient evidence for a suggested starting point. All projects remain available.",
  "no-suitable-candidate":
    "No assessed candidate meets this context and its requirements. Existing operation rules are unchanged.",
};
function time(value: number | null | undefined) {
  if (value === undefined || value === null) return "Not observed";
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "Outside displayable date range";
}

export function GameComparisonControls({ comparison }: { comparison: Comparison }) {
  const { report, context, setContext } = comparison;
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
    <section
      className="space-y-3 rounded-pc-md border border-pc-border p-3"
      aria-label="Recommendation context"
      data-focus-group
    >
      <h3 className="font-semibold">Which project fits?</h3>
      <p className="text-sm text-pc-muted-foreground">
        Recommendations describe evidence, not permission to install or launch. Nothing here
        switches a project, channel, original file or save.
      </p>
      {!comparison.enabled ? (
        <p role="status">
          Comparison evidence is unavailable in this view. Ordinary project details and actions
          remain available.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <ChoiceSelect
              label="Source edition"
              value={context.edition || "automatic"}
              options={[
                { value: "automatic", label: "Use an unambiguous edition" },
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
                { value: "windows-x86-64", label: "Windows x64" },
                { value: "linux-x86-64", label: "Linux x64" },
                { value: "macos-x86-64", label: "macOS Intel" },
                { value: "macos-aarch64", label: "macOS Apple silicon" },
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
                label="Evidence environment"
                value={context.environment || "current"}
                description="Selecting a recorded environment inspects that context; it does not verify that your device matches."
                options={[
                  { value: "current", label: "Current device — not qualified" },
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
            <legend>Required capabilities</legend>
            {[
              ["multiplayer", "Multiplayer"],
              ["controller", "Controller support"],
            ].map(([id, label]) => (
              <label key={id} className="inline-flex items-center gap-2">
                <input
                  data-focusable
                  type="checkbox"
                  className={controlFocus}
                  checked={context.requirements.includes(id!)}
                  onChange={(event) => updateRequirement(id!, event.target.checked)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={comparison.loading}
            onClick={() => void comparison.refresh()}
          >
            Refresh release observations
          </Button>
          <p role="status" aria-live="polite" className="text-sm">
            {comparison.loading
              ? "Refreshing the selected comparison…"
              : comparison.failed
                ? "Comparison evidence is unavailable. Ordinary project details and actions remain available."
                : report?.assessment
                  ? statuses[report.assessment.status]
                  : "Choose a known source edition and inspect available evidence. No recommendation is implied."}
          </p>
          {report?.limitations.map((limitation) => (
            <p key={limitation} className="text-xs text-pc-muted-foreground">
              {limitation}
            </p>
          ))}
          <p className="text-xs text-pc-muted-foreground">
            Original-file matches and device/installation readiness are separate. Release resolution
            can reuse the provider cache. Following is local and opt-in; changes appear when
            observations refresh.
          </p>
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
  const report = comparison.report;
  const port = report?.ports.find((row) => row.port_id === portId);
  if (!port) return null;
  const candidate = report?.assessment?.candidates.find(
    (candidate) => candidate.scope.port_id === portId,
  );
  const recommended = !comparison.loading && report?.assessment?.recommended?.port_id === portId;
  const followed = organization?.snapshot?.followed_port_ids.includes(portId) ?? false;
  return (
    <section
      className="mt-3 space-y-2 border-t border-pc-border pt-3"
      aria-label={`Evidence for ${port.name}`}
      data-focus-group
    >
      {recommended && <Chip>Suggested starting point</Chip>}
      {!comparison.loading &&
        report?.assessment?.status === "comparable-alternatives" &&
        report.assessment.comparable.some((scope) => scope.port_id === portId) && (
          <Chip>Comparable option</Chip>
        )}
      <p className="text-xs">
        {port.offered_release
          ? `Offered ${port.offered_release.version} · ${port.offered_release.channel} · artifact ${port.offered_release.artifact_sha256.slice(0, 12)}`
          : "No exact offered artifact observed for this context."}
      </p>
      <p className="text-xs text-pc-muted-foreground">
        {port.freshness.state === "catalog-pinned"
          ? "Catalog-pinned identity; not a new upstream check."
          : `Last successful provider resolution: ${time(port.freshness.last_successful_resolution_at)}. Latest observation: ${port.freshness.state}.`}
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
          ? "launch-ready under existing Core checks"
          : "launch readiness not established"}
        . This does not qualify the selected evidence environment.
      </p>
      <p className="text-xs">
        Original-file status: {port.source_health ?? "not assessed"}. Source profiles:{" "}
        {port.source_profile_ids.join(", ") || "none declared"}.
      </p>
      <details>
        <summary data-focusable className={`cursor-pointer text-sm font-medium ${controlFocus}`}>
          Why this port? — {port.name}
        </summary>
        <div className="mt-2 space-y-2 text-xs">
          {port.limitations.map((limitation) => (
            <p key={limitation}>{limitation}</p>
          ))}
          {candidate ? (
            <>
              <p>
                Evidence coverage describes recorded facts, not the probability of successful play.
                This policy is {report?.policy_version}.
              </p>
              {candidate.reasons.map((reason) => (
                <p key={reason}>{reasons[reason]}</p>
              ))}
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                {candidate.dimensions.map((dimension) => (
                  <div key={dimension.dimension}>
                    <dt className="font-medium">{dimensions[dimension.dimension]}</dt>
                    <dd>
                      {dimension.state === "known"
                        ? "Scoped evidence available"
                        : dimension.state.replaceAll("-", " ")}
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
                    {dimensions[record.evidence.dimension]} ·{" "}
                    {record.evidence.kind.replaceAll("-", " ")} ·{" "}
                    {record.disposition.replaceAll("-", " ")}
                  </p>
                  <p>{record.evidence.explanation}</p>
                  <p>
                    Observed {time(record.evidence.observed_at)} for{" "}
                    {record.evidence.scope.release_id}, {record.evidence.scope.platform},{" "}
                    {record.evidence.scope.environment_id}.
                  </p>
                  <p>Artifact: {record.evidence.scope.artifact_id}</p>
                  <ExternalLink href={record.evidence.source}>
                    Attributable evidence source
                  </ExternalLink>
                </div>
              ))}
            </>
          ) : (
            <p>
              No quality assessment is available for this edition/artifact. The project remains
              listed.
            </p>
          )}
        </div>
      </details>
      {organization && (
        <div className="flex flex-wrap gap-2">
          <Button
            data-focusable
            size="sm"
            variant={followed ? "selected" : "outline"}
            aria-pressed={followed}
            disabled={!organization.snapshot || organization.busy || comparison.loading}
            onClick={() =>
              void organization.commit({
                kind: "set_followed_project",
                port_id: portId,
                followed: !followed,
                observed_identity: port.offered_identity,
              })
            }
          >
            {followed ? `Following ${port.name}` : `Follow ${port.name}`}
          </Button>
          {port.update_notice && followed && (
            <div role="status" className="basis-full text-sm">
              <p>
                New release identity observed: {port.update_notice.version} ·{" "}
                {port.update_notice.artifact_sha256.slice(0, 12)}. This does not install or switch
                anything.
              </p>
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
                Mark observed update as seen
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
