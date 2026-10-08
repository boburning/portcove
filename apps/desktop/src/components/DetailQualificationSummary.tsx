import type { PortDefinition, SourceInspectionReport } from "../types";
import type { SourceEvidence, SourceVariant } from "../transport-types.generated";
import { platformLabel } from "../view-model";

const kindLabels = {
  structural_check: "Structural check",
  automated_lifecycle: "Automated lifecycle",
  hands_on: "Hands-on observation",
  known_failure: "Known failure",
};
const outcomeLabels = {
  passed: "Passed",
  failed: "Failed",
  not_run: "Not run",
  unknown: "Outcome unknown",
};

export function DetailQualificationSummary({
  port,
  sourceInspection,
  biosInspection,
  technical = false,
}: {
  port: PortDefinition;
  sourceInspection?: SourceInspectionReport;
  biosInspection?: SourceInspectionReport;
  technical?: boolean;
}) {
  return (
    <>
      {!technical && (
        <div className="metadata">
          <span>
            <small>Legacy port-wide automated tests</small>
            {legacyCoverage(port.platforms, port.automated_tested_platforms)}
          </span>
          <span>
            <small>Legacy port-wide hands-on tests</small>
            {legacyCoverage(port.platforms, port.manually_validated_platforms)}
          </span>
        </div>
      )}
      {!technical && (
        <p className="text-sm text-pc-muted-foreground">
          Recorded history, not a fresh check of your current files, release or device. Structural
          and lifecycle passes do not establish gameplay or permission to launch. Legacy platform
          coverage does not identify an exact artifact, edition or file format.
        </p>
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
          <section
            key={role}
            aria-label={`Recorded ${role === "game" ? "game-file" : "BIOS"} checks`}
          >
            <h3 className="text-sm font-medium">
              {role === "game" ? "Game-file" : "BIOS"} recorded observations
            </h3>
            {!application ? (
              <p>
                File-check report unavailable for this requirement. Catalog evidence may still
                exist.
              </p>
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
                  <p>No matching recorded observations supplied by this report.</p>
                )}
                {records?.length !== application.qualification.exact_records.length && (
                  <p>Some recorded scopes could not be verified for this requirement.</p>
                )}
              </>
            )}
            <p className="text-sm text-pc-muted-foreground">
              Current applicability is unknown: this view has no current device, artifact or
              inspection freshness context.
            </p>
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
      : "Not recorded — scope unknown";
  const observedAt = new Date(record.observed_at * 1000);
  return (
    <div className="grid gap-1 text-sm break-words">
      <strong>
        {kindLabels[record.kind] ?? "Check kind unknown"} ·{" "}
        {outcomeLabels[record.outcome] ?? "Outcome unknown"}
      </strong>
      <p>{record.method || "Method not recorded"}</p>
      <dl className="qualification-grid">
        <div>
          <dt>Recorded platform</dt>
          <dd>{platformLabel(record.scope.platform)}</dd>
        </div>
        <div>
          <dt>Observed date (UTC)</dt>
          <dd>
            {Number.isNaN(observedAt.getTime())
              ? "Not recorded"
              : observedAt.toISOString().slice(0, 10)}
          </dd>
        </div>
        <div>
          <dt>Recorded edition and format</dt>
          <dd>
            {technical && identity
              ? `${identity.game_id} · ${identity.variant_id} · ${identity.representation_id}`
              : edition}
          </dd>
        </div>
        <div>
          <dt>Recorded release</dt>
          <dd>{record.scope.upstream_ref || "Not recorded — scope unknown"}</dd>
        </div>
        {technical && (
          <div>
            <dt>Recorded contract</dt>
            <dd>{record.scope.contract_id || "Not recorded — scope unknown"}</dd>
          </div>
        )}
        {technical && (
          <div>
            <dt>Recorded check version</dt>
            <dd>{record.scope.check_version || "Not recorded — scope unknown"}</dd>
          </div>
        )}
        {technical && (
          <div>
            <dt>Recorded artifact SHA-256</dt>
            <dd>
              <code className="break-all">
                {record.scope.artifact_sha256 || "Not recorded — scope unknown"}
              </code>
            </dd>
          </div>
        )}
      </dl>
      {!technical && (
        <p>
          {record.scope.check_version && record.scope.artifact_sha256
            ? "Artifact and check identities recorded in Technical details."
            : "Artifact or check identity not recorded — scope unknown."}
        </p>
      )}
    </div>
  );
}

function legacyCoverage(
  supported: PortDefinition["platforms"],
  completed: PortDefinition["platforms"],
) {
  const completedSet = new Set(completed);
  const recorded = supported.filter((platform) => completedSet.has(platform));
  if (recorded.length === 0) return "No legacy platform coverage recorded";
  const unrecorded = supported.filter((platform) => !completedSet.has(platform));
  const completedLabel = recorded.map((platform) => platformLabel(platform)).join(" · ");
  return unrecorded.length === 0
    ? completedLabel
    : `${completedLabel} · Not recorded: ${unrecorded.map((platform) => platformLabel(platform)).join(" · ")}`;
}
