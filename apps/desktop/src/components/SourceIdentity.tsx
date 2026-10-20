import { MetadataGrid } from "./ui/patterns";
import { cn } from "cn";
import { useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clipboard,
  ClipboardCheck,
  ExternalLink,
  HelpCircle,
  ShieldAlert,
} from "lucide-react";
import { copyText } from "../clipboard";
import type {
  DigestIdentity,
  ObservedSourceComponent,
  ObservedSourceDigest,
  SourceInspectionReport,
  SourceRepresentation,
} from "../types";
import { platformLabel } from "../view-model";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const sourceToneClasses: Record<string, string> = {
  success: "text-pc-success-foreground",
  warning: "text-pc-warning-foreground",
  danger: "text-pc-danger-foreground",
  neutral: "text-pc-muted-foreground",
  "contract-supported": "text-pc-success-foreground",
  "contract-informational": "text-pc-info-foreground",
  "contract-recognized_not_listed": "text-pc-warning-foreground",
  "contract-unreviewed_for_release": "text-pc-warning-foreground",
  "contract-known_incompatible": "text-pc-danger-foreground",
  "contract-not_evaluated": "text-pc-muted-foreground",
};
export function SourceIdentityPanel({
  report,
  openEvidence,
  openHostTool,
}: {
  report: SourceInspectionReport;
  openEvidence?: ((evidenceId: string) => void) | undefined;
  openHostTool?: ((toolId: string) => void) | undefined;
}) {
  const inspection = report.inspection;
  const recognized =
    inspection?.assessment.classification.state === "recognized"
      ? inspection.assessment.classification.identity
      : undefined;
  const variant = report.expected_identity?.variants.find(
    (candidate) => candidate.id === recognized?.variant_id,
  );
  const state = sourceDisplayState(report);
  const checkLabel =
    report.applications.length > 0 &&
    report.applications.every((application) => application.role === "bios")
      ? "BIOS check"
      : report.applications.some((application) => application.role === "bios")
        ? "File check"
        : "Game-file check";
  const problemToolId = report.problem?.tool_id;
  return (
    <section
      className="source-identity @container/source mt-3 grid gap-3 rounded-pc-lg border border-pc-border bg-pc-surface p-4"
      aria-label={`${checkLabel} for ${report.expected_identity?.label ?? report.profile_id}`}
    >
      <p
        className="sr-only m-0 leading-[var(--leading-relaxed)] text-[var(--color-text-muted)]"
        role="status"
      >
        {checkLabel} result: {state.label}. {report.summary}
      </p>
      <div className="flex items-center justify-between gap-3 @max-[30rem]/source:flex-col @max-[30rem]/source:items-start">
        <div className="grid gap-0.5">
          <small className="text-pc-muted-foreground">{checkLabel}</small>
          <strong>{report.expected_identity?.label ?? report.profile_id}</strong>
        </div>
        <span
          className={cn(
            "source-result inline-flex items-center gap-1 text-xs font-medium",
            sourceToneClasses[state.tone],
          )}
        >
          <Icon glyph={state.icon} size="sm" />
          {state.label}
        </span>
      </div>
      <p className="m-0 leading-[var(--leading-relaxed)] text-[var(--color-text-muted)]">
        {report.summary}
      </p>
      {report.problem && (
        <p
          className="source-problem m-0 flex gap-2 leading-[var(--leading-relaxed)] text-[var(--color-text-muted)]"
          role="status"
        >
          <Icon glyph={AlertTriangle} size="sm" />
          {report.problem.message}
        </p>
      )}
      {problemToolId && openHostTool && (
        <Button
          data-focusable
          variant="outline"
          size="sm"
          onClick={() => openHostTool(problemToolId)}
        >
          Review disc tool settings
        </Button>
      )}
      <p className="source-next m-0 leading-[var(--leading-relaxed)] text-[var(--color-text-muted)]">
        <strong>Next:</strong> {report.next_action}
      </p>
      <MetadataGrid className="source-identity-summary @max-[30rem]/source:grid-cols-[1fr]">
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt className="m-0 text-[length:var(--text-2xs)] tracking-[0.04em] text-[var(--color-text-muted)] uppercase">
            Selected
          </dt>
          <dd className="m-0 mt-[2px] [overflow-wrap:anywhere]">
            <code className="inline [overflow-wrap:anywhere] whitespace-normal">
              {inspection?.path ?? report.registered?.path ?? "No file location saved"}
            </code>
          </dd>
        </div>
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt className="m-0 text-[length:var(--text-2xs)] tracking-[0.04em] text-[var(--color-text-muted)] uppercase">
            Format
          </dt>
          <dd className="m-0 mt-[2px] [overflow-wrap:anywhere]">
            {identityKindLabel(report.expected_identity?.kind)}
          </dd>
        </div>
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt className="m-0 text-[length:var(--text-2xs)] tracking-[0.04em] text-[var(--color-text-muted)] uppercase">
            Edition
          </dt>
          <dd className="m-0 mt-[2px] [overflow-wrap:anywhere]">
            {variant ? variantLabel(variant) : classificationLabel(report)}
          </dd>
        </div>
      </MetadataGrid>
      {report.applications.map((application) => (
        <ApplicationResult
          key={`${application.port_id}:${application.role}`}
          application={application}
          selectedVariantId={recognized?.variant_id}
          selectedRepresentationId={recognized?.representation_id}
        />
      ))}
      <details className="source-technical border-t border-pc-border">
        <summary
          data-focusable
          className="cursor-pointer py-3 font-medium text-pc-interactive-foreground"
        >
          Full identity and evidence
        </summary>
        <div className="grid gap-4 [&_h4]:mt-3 [&_h4]:mb-2">
          <MetadataGrid className="source-identity-summary @max-[30rem]/source:grid-cols-[1fr]">
            <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
              <dt className="m-0 text-[length:var(--text-2xs)] tracking-[0.04em] text-[var(--color-text-muted)] uppercase">
                Admission
              </dt>
              <dd className="m-0 mt-[2px] [overflow-wrap:anywhere]">{admissionLabel(report)}</dd>
            </div>
          </MetadataGrid>
          <IdentityDigests report={report} />
          <Qualification report={report} />
          {report.evidence.length > 0 && (
            <section>
              <h4>Reviewed evidence</h4>
              <ul className="source-evidence-list m-0 grid list-none gap-2 p-0">
                {report.evidence.map((evidence) => (
                  <li
                    className="flex items-center justify-between gap-3 @max-[30rem]/source:flex-col @max-[30rem]/source:items-start"
                    key={evidence.id}
                  >
                    <span className="grid gap-[2px]">
                      <strong>{evidence.authority}</strong>
                      <small>{evidence.claim}</small>
                    </span>
                    <Button
                      data-focusable
                      variant="outline"
                      size="sm"
                      onClick={() => openEvidence?.(evidence.id)}
                      disabled={!openEvidence}
                      aria-label={`Open reviewed evidence from ${evidence.authority}`}
                    >
                      <Icon glyph={ExternalLink} size="sm" />
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="source-boundary m-0 rounded-pc-md bg-[var(--color-success-subtle)] p-3 leading-[var(--leading-relaxed)] text-[var(--color-text-muted)]">
            <strong>Read-only check.</strong> Portcove calculated these values locally. It did not
            modify, normalize, move, or upload the selected files.
          </p>
        </div>
      </details>
    </section>
  );
}

function ApplicationResult({
  application,
  selectedVariantId,
  selectedRepresentationId,
}: {
  application: SourceInspectionReport["applications"][number];
  selectedVariantId?: string | undefined;
  selectedRepresentationId?: string | undefined;
}) {
  const result = contractLabel(application.contract_result.state);
  const applicability = applicabilityLabel(
    application.release_applicability.state_code,
    application.contract_result.state,
  );
  const exactAutomated = application.qualification.exact_records.filter(
    (record) => record.kind === "automated_lifecycle",
  );
  const exactHandsOn = application.qualification.exact_records.filter(
    (record) => record.kind === "hands_on",
  );
  const selectedHandsOn = exactHandsOn.filter(
    (record) =>
      selectedVariantId &&
      selectedRepresentationId &&
      record.scope.variant.state === "exact" &&
      record.scope.variant.identity.variant_id === selectedVariantId &&
      record.scope.variant.identity.representation_id === selectedRepresentationId,
  );
  return (
    <section
      className="source-application grid gap-2 rounded-pc-md border border-[var(--color-border)] p-3"
      aria-label={`${application.port_name} ${application.role} requirement`}
    >
      <div className="flex items-center justify-between gap-3 @max-[30rem]/source:flex-col @max-[30rem]/source:items-start">
        <strong>
          {application.port_name} · {application.role === "bios" ? "BIOS" : "Game file"}
        </strong>
        <span
          className={cn(
            "source-contract inline-flex items-center gap-1 text-xs font-medium",
            sourceToneClasses[`contract-${application.contract_result.state}`],
          )}
        >
          {result}
        </span>
      </div>
      <MetadataGrid className="@max-[30rem]/source:grid-cols-[1fr]">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-pc-md bg-[var(--color-bg-inset)] p-2 @max-[30rem]/source:flex-col @max-[30rem]/source:items-start">
          <dt>Release applicability</dt>
          <dd>{applicability}</dd>
        </div>
      </MetadataGrid>
      {selectedVariantId && selectedHandsOn.length === 0 && (
        <p className="text-[length:var(--text-xs)]">
          No hands-on test is recorded for this edition and file format.
        </p>
      )}
      {selectedHandsOn.length > 0 && (
        <p className="text-[length:var(--text-xs)]">
          Hands-on results for this edition and file format:{" "}
          {selectedHandsOn.map((record) => evidenceOutcome(record.outcome)).join(", ")}.
        </p>
      )}
      <details className="source-technical border-t border-pc-border">
        <summary
          data-focusable
          className="cursor-pointer py-3 font-medium text-pc-interactive-foreground"
        >
          File details and test results
        </summary>
        <small className="text-[var(--color-text-muted)]">
          {application.contract.authority_ref}
        </small>
        <MetadataGrid className="@max-[30rem]/source:grid-cols-[1fr]">
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-pc-md bg-[var(--color-bg-inset)] p-2 @max-[30rem]/source:flex-col @max-[30rem]/source:items-start">
            <dt>Recorded automated results</dt>
            <dd>{evidenceDetails(exactAutomated, "No automated test recorded")}</dd>
          </div>
          <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
            <dt>Recorded hands-on results</dt>
            <dd>{evidenceDetails(exactHandsOn, "No hands-on test recorded")}</dd>
          </div>
        </MetadataGrid>
      </details>
    </section>
  );
}

function IdentityDigests({ report }: { report: SourceInspectionReport }) {
  const inspection = report.inspection;
  const recognized =
    inspection?.assessment.classification.state === "recognized"
      ? inspection.assessment.classification.identity
      : undefined;
  const variants = recognized
    ? (report.expected_identity?.variants.filter(
        (variant) => variant.id === recognized.variant_id,
      ) ?? [])
    : (report.expected_identity?.variants ?? []);
  return (
    <section>
      <h4>Calculated identity</h4>
      {inspection ? (
        <>
          <DigestList label="Selected file" digests={inspection.observed_digests} calculated />
          {inspection.components.map((component) => (
            <ObservedComponent key={component.id} component={component} />
          ))}
        </>
      ) : (
        <p>No calculated identity is available.</p>
      )}
      <h4>Expected identity</h4>
      {variants.length > 0 ? (
        variants.map((variant) => (
          <div
            className="expected-variant mt-2 grid gap-2 rounded-pc-md bg-[var(--color-bg-inset)] p-3"
            key={variant.id}
          >
            <strong>{variantLabel(variant)}</strong>
            {variant.representations.map((representation) => (
              <ExpectedRepresentation key={representation.id} representation={representation} />
            ))}
          </div>
        ))
      ) : (
        <p>Expected values: Missing from the active catalog.</p>
      )}
    </section>
  );
}

function ExpectedRepresentation({ representation }: { representation: SourceRepresentation }) {
  const groups = expectedGroups(representation);
  return (
    <div className="expected-representation mt-2 grid gap-2 ps-3 [border-left:2px_solid_var(--color-border)]">
      <span>
        {representationKindLabel(representation.kind)} ·{" "}
        {representation.extensions.length
          ? representation.extensions.join(", ")
          : "No filename extension"}
      </span>
      {representationFacts(representation).map((fact) => (
        <small key={fact}>{fact}</small>
      ))}
      {groups.length ? (
        groups.map((group) => (
          <ExpectedDigestGroup
            key={group.label}
            label={group.label}
            identities={group.identities}
          />
        ))
      ) : (
        <p>
          <strong>Expected SHA-256:</strong> Missing from reviewed evidence.
        </p>
      )}
    </div>
  );
}

function ExpectedDigestGroup({
  label,
  identities,
}: {
  label: string;
  identities: DigestIdentity[];
}) {
  return (
    <div className="digest-group mt-2 grid gap-2">
      <small>{label}</small>
      {identities.length ? (
        identities.map((identity, index) => (
          <div key={`${identity.scope}:${index}`}>
            <DigestValue label="Expected SHA-256" scope={identity.scope} value={identity.sha256} />
            <DigestValue label="Expected SHA-1" scope={identity.scope} value={identity.sha1} />
            <DigestValue label="Expected CRC32" scope={identity.scope} value={identity.crc32} />
          </div>
        ))
      ) : (
        <p>
          <strong>Expected SHA-256:</strong> Missing from reviewed evidence.
        </p>
      )}
    </div>
  );
}

function ObservedComponent({ component }: { component: ObservedSourceComponent }) {
  const detail = [
    component.name,
    component.track_count != null ? `${component.track_count} tracks` : undefined,
    component.volume_id ? `Volume ${component.volume_id}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="observed-component">
      <small>Observed member evidence</small>
      <DigestList
        label={`${componentKindLabel(component.kind)} · ${component.id}${detail ? ` · ${detail}` : ""}`}
        digests={component.digests}
        calculated
      />
    </div>
  );
}

function DigestList({
  label,
  digests,
  calculated,
}: {
  label: string;
  digests: ObservedSourceDigest[];
  calculated?: boolean;
}) {
  return (
    <div className="digest-group mt-2 grid gap-2">
      <small>{label}</small>
      {digests.length ? (
        digests.map((digest, index) => (
          <DigestValue
            key={`${digest.algorithm}:${digest.scope}:${index}`}
            label={`${calculated ? "Calculated" : "Expected"} ${digest.algorithm.toUpperCase()}`}
            scope={digest.scope}
            value={digest.value}
          />
        ))
      ) : (
        <p>No calculated hashes are available.</p>
      )}
    </div>
  );
}

type DigestValueProps = { label: string; scope: string; value: string | null };

function DigestValue(props: DigestValueProps) {
  return (
    <DigestValueContent key={JSON.stringify([props.label, props.scope, props.value])} {...props} />
  );
}

function DigestValueContent({ label, scope, value }: DigestValueProps) {
  const [copyOutcome, setCopyOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const copyRequest = useRef(0);
  useLayoutEffect(
    () => () => {
      ++copyRequest.current;
    },
    [],
  );
  if (!value)
    return (
      <p className="digest-value missing grid min-w-0 grid-cols-[minmax(0,_1fr)_auto] items-center gap-[3px_var(--space-2)] [&.missing]:grid-cols-[1fr] [&.missing]:rounded-pc-md [&.missing]:p-2 [&.missing]:[border:1px_dashed_var(--color-warning-border)]">
        <strong className="text-[length:var(--text-xs)] font-medium">
          {label} · {digestScopeLabel(scope)}
        </strong>
        <span className="text-[var(--color-warning-text)]">Missing from reviewed evidence</span>
      </p>
    );
  const copy = () => {
    const current = ++copyRequest.current;
    setCopyOutcome("idle");
    void copyText(value)
      .then(() => {
        if (copyRequest.current === current) setCopyOutcome("copied");
      })
      .catch(() => {
        if (copyRequest.current === current) setCopyOutcome("failed");
      });
  };
  return (
    <div className="digest-value grid min-w-0 grid-cols-[minmax(0,_1fr)_auto] items-center gap-[3px_var(--space-2)] [&.missing]:grid-cols-[1fr] [&.missing]:rounded-pc-md [&.missing]:p-2 [&.missing]:[border:1px_dashed_var(--color-warning-border)]">
      <strong className="text-[length:var(--text-xs)] font-medium">
        {label} · {digestScopeLabel(scope)}
      </strong>
      <code className="col-[1] block bg-[transparent] p-0 [overflow-wrap:anywhere] whitespace-normal text-[var(--color-text-muted)]">
        {value}
      </code>
      <Button
        className="col-[2] row-span-2"
        data-focusable
        variant="ghost"
        size="icon-sm"
        aria-label={`Copy ${label} for ${digestScopeLabel(scope)}`}
        onClick={copy}
      >
        <Icon glyph={copyOutcome === "copied" ? ClipboardCheck : Clipboard} size="sm" />
      </Button>
      {copyOutcome === "copied" && (
        <p role="status">
          {label} for {digestScopeLabel(scope)} copied.
        </p>
      )}
      {copyOutcome === "failed" && (
        <>
          <p role="alert">
            Clipboard unavailable. Select and copy {label} for {digestScopeLabel(scope)} below.
          </p>
          <Input
            readOnly
            data-focusable
            aria-label={`${label} for ${digestScopeLabel(scope)} for manual copy`}
            value={value}
          />
        </>
      )}
    </div>
  );
}

function Qualification({ report }: { report: SourceInspectionReport }) {
  const legacyAutomated = new Set(
    report.applications.flatMap(
      (application) => application.qualification.legacy_automated_platforms,
    ),
  );
  const legacyHandsOn = new Set(
    report.applications.flatMap(
      (application) => application.qualification.legacy_hands_on_platforms,
    ),
  );
  return (
    <section>
      <h4>Test coverage</h4>
      <MetadataGrid className="qualification-grid @max-[30rem]/source:grid-cols-[1fr]">
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt>Legacy port-wide automated</dt>
          <dd>{platformList(legacyAutomated) || "Not recorded"}</dd>
        </div>
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt>Legacy port-wide hands-on</dt>
          <dd>{platformList(legacyHandsOn) || "Not recorded"}</dd>
        </div>
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt>Registration identity</dt>
          <dd>
            {report.legacy.registration_identity_not_recorded
              ? "Legacy registration · exact identity was not recorded"
              : "Structured observation recorded"}
          </dd>
        </div>
        <div className="min-w-0 rounded-pc-md bg-[var(--color-bg-inset)] p-2">
          <dt>Variant-unspecified records</dt>
          <dd>{report.legacy.variant_unspecified_records.length || "None"}</dd>
        </div>
      </MetadataGrid>
    </section>
  );
}

function expectedGroups(
  representation: SourceRepresentation,
): Array<{ label: string; identities: DigestIdentity[] }> {
  if (
    representation.kind === "raw-file" ||
    representation.kind === "canonical-n64" ||
    representation.kind === "archive-member" ||
    representation.kind === "gamecube-normalized-iso" ||
    representation.kind === "optical-track-set" ||
    representation.kind === "compound"
  )
    return [{ label: representation.id, identities: representation.identities }];
  if (representation.kind === "file-set")
    return representation.members.map((member) => ({
      label: `${member.label} · ${member.filenames.join(", ")}`,
      identities: member.identities,
    }));
  if (representation.kind === "relative-file-set")
    return representation.members.map((member) => ({
      label: `${member.path} · ${member.size.toLocaleString()} bytes`,
      identities: [{ scope: "file-set-member", sha256: member.sha256, sha1: null, crc32: null }],
    }));
  if (representation.kind === "multi-disc-set")
    return representation.discs.map((disc) => ({
      label: `${disc.label} · ${disc.track_counts.join("/")} tracks`,
      identities: disc.identities,
    }));
  return [];
}

function representationFacts(representation: SourceRepresentation) {
  if (representation.kind === "volume-id")
    return [
      `Volume IDs: ${representation.values.join(", ") || "Missing"}`,
      `Track counts: ${representation.track_counts.join(", ") || "Missing"}`,
    ];
  if (representation.kind === "pinned-validator")
    return [`Reviewed validator: ${representation.validator_contract_id}`];
  if (representation.kind === "informational-extension")
    return [`Evidence gap: ${representation.evidence_gap}`];
  return [];
}

function sourceDisplayState(report: SourceInspectionReport) {
  const admission = report.inspection?.assessment.admission;
  const unknownEditionLabel =
    admission?.state === "admitted" && admission.mode === "structural_checks"
      ? "Basic file checks passed · compatibility unconfirmed"
      : "Edition unknown · review check details";
  const known = {
    check_failed: {
      label: "File checks failed",
      tone: "danger",
      icon: ShieldAlert,
    },
    recognized_exact: { label: "Exact match", tone: "success", icon: Check },
    accepted_identity_unknown: {
      label: unknownEditionLabel,
      tone: "warning",
      icon: HelpCircle,
    },
    source_changed: {
      label: "Files changed since they were added",
      tone: "danger",
      icon: ShieldAlert,
    },
    ambiguous_identity: {
      label: "More checks needed · edition unclear",
      tone: "warning",
      icon: HelpCircle,
    },
    selected_needs_checking: {
      label: "More checks needed",
      tone: "warning",
      icon: HelpCircle,
    },
    known_mismatch: {
      label: "Files don't match reviewed requirements",
      tone: "danger",
      icon: ShieldAlert,
    },
    source_missing: {
      label: "Files not found",
      tone: "danger",
      icon: AlertTriangle,
    },
    source_could_not_be_checked: {
      label: "Files couldn't be checked",
      tone: "danger",
      icon: AlertTriangle,
    },
    not_evaluated: {
      label: "Not evaluated",
      tone: "neutral",
      icon: HelpCircle,
    },
  } as const;
  return Object.hasOwn(known, report.state_code)
    ? known[report.state_code as keyof typeof known]
    : { label: "Result unavailable", tone: "neutral", icon: HelpCircle };
}

function classificationLabel(report: SourceInspectionReport) {
  const classification = report.inspection?.assessment.classification;
  if (!classification)
    return report.legacy.registration_identity_not_recorded
      ? "Legacy registration · not evaluated"
      : "Couldn't check";
  if (classification.state === "recognized") return classification.identity.variant_id;
  if (classification.state === "ambiguous")
    return `${classification.candidates.length} possible editions`;
  if (classification.state === "unrecognized") return "Unidentified edition";
  return "Not evaluated";
}

export function sourceAdmissionPresentation(mode: string) {
  const modes = {
    exact_identity: {
      label: "Exact identity",
      detailLabel: "Admitted · exact identity",
      explanation:
        "The source matched an accepted exact identity. This is not installation or gameplay proof.",
    },
    structural_checks: {
      label: "Structural checks",
      detailLabel: "Admitted · structural checks",
      explanation:
        "Required file checks passed. Structural admission alone does not establish an exact edition.",
    },
    informational_consent: {
      label: "Informational consent",
      detailLabel: "Admitted · informational consent",
      explanation:
        "The source was admitted under its informational rules. This does not verify an exact edition.",
    },
    upstream_validator: {
      label: "Upstream validator",
      detailLabel: "Admitted · upstream validator",
      explanation:
        "The configured upstream validator accepted the source. The admission label alone does not establish an exact edition.",
    },
  };
  return Object.hasOwn(modes, mode)
    ? { ...modes[mode as keyof typeof modes], known: true }
    : {
        label: "Source check unavailable",
        detailLabel: "Admission result unavailable",
        explanation:
          "This version cannot explain the reviewed source check. Cancel this review and check the files again, or update Portcove if this continues.",
        known: false,
      };
}

function admissionLabel(report: SourceInspectionReport) {
  const admission = report.inspection?.assessment.admission;
  if (!admission || admission.state === "not_evaluated") return "Not evaluated";
  if (admission.state === "rejected")
    return `File not accepted · ${rejectionReason(admission.reason)}`;
  if (admission.state !== "admitted") return "Not evaluated";
  return sourceAdmissionPresentation(admission.mode).detailLabel;
}

function contractLabel(
  state: SourceInspectionReport["applications"][number]["contract_result"]["state"],
) {
  const labels = {
    supported: "Matches evaluated source requirements",
    recognized_not_listed: "Recognized · not listed",
    known_incompatible: "Known mismatch · refused",
    informational: "Informational requirement",
    unreviewed_for_release: "Not reviewed for this release",
    not_evaluated: "Not evaluated",
  };
  return Object.hasOwn(labels, state) ? labels[state] : "Requirement result unavailable";
}

function applicabilityLabel(
  state: string,
  contract: SourceInspectionReport["applications"][number]["contract_result"]["state"],
) {
  if (contract === "unreviewed_for_release") return "Not reviewed for this release";
  const labels: Record<string, string> = {
    artifact_bound: "Bound to this exact release artifact",
    upstream_release_bound: "Bound to the reviewed upstream release",
    not_rebound: "No release-specific binding is recorded",
  };
  return Object.hasOwn(labels, state) ? labels[state] : "Release applicability unavailable";
}

function variantLabel(
  variant: NonNullable<SourceInspectionReport["expected_identity"]>["variants"][number],
) {
  const details = [variant.region, variant.revision, ...variant.product_codes].filter(Boolean);
  return `${variant.title}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function evidenceDetails(
  records: SourceInspectionReport["applications"][number]["qualification"]["exact_records"],
  emptyLabel: string,
) {
  if (records.length === 0) return emptyLabel;
  return (
    <ul>
      {records.map((record, index) => (
        <li key={`${record.scope.platform}:${record.observed_at}:${index}`}>
          {evidenceOutcome(record.outcome)} · {platformLabel(record.scope.platform)} ·{" "}
          {record.scope.variant.state === "exact"
            ? `Edition ${record.scope.variant.identity.variant_id}, format ${record.scope.variant.identity.representation_id}`
            : "Edition not recorded"}
          {record.scope.upstream_ref && ` · Release ${record.scope.upstream_ref}`}
          {record.scope.check_version && ` · Check version ${record.scope.check_version}`}
          {record.scope.artifact_sha256 && (
            <>
              {" · Release artifact SHA-256 "}
              <code>{record.scope.artifact_sha256}</code>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function evidenceOutcome(outcome: string) {
  const labels: Record<string, string> = {
    passed: "Passed",
    failed: "Failed",
    not_run: "Not run",
    unknown: "Outcome unknown",
  };
  return Object.hasOwn(labels, outcome) ? labels[outcome] : "Outcome unavailable";
}

function platformList(platforms: Set<string>) {
  return [...platforms].map((platform) => platformLabel(platform)).join(" · ");
}

function identityKindLabel(value?: string) {
  const labels: Record<string, string> = {
    file: "File",
    "file-set": "Set of files",
    "optical-disc": "Disc",
    "multi-disc-set": "Set of discs",
    compound: "Combined file",
  };
  return value && Object.hasOwn(labels, value) ? labels[value] : "Format not recorded";
}

function representationKindLabel(value: string) {
  const labels: Record<string, string> = {
    "raw-file": "Original file",
    "canonical-n64": "Normalized N64 file",
    "archive-member": "File inside archive",
    "file-set": "Set of files",
    "relative-file-set": "Complete data folder",
    "gamecube-normalized-iso": "Normalized GameCube disc",
    "optical-track-set": "Disc tracks",
    "multi-disc-set": "Set of discs",
    "volume-id": "Disc volume ID",
    "pinned-validator": "Reviewed file check",
    compound: "Combined file",
    "informational-extension": "File extension information",
  };
  return Object.hasOwn(labels, value) ? labels[value] : "File format unavailable";
}

function componentKindLabel(value: string) {
  const labels: Record<string, string> = {
    file_set_member: "File in set",
    optical_disc: "Disc",
  };
  return Object.hasOwn(labels, value) ? labels[value] : "File component unavailable";
}

function digestScopeLabel(value: string) {
  const labels: Record<string, string> = {
    "original-file": "original file",
    "original-container": "original container",
    "normalized-content": "normalized content",
    "canonical-n64-big-endian": "normalized N64 content",
    "archive-member": "file inside archive",
    "gamecube-normalized-iso": "normalized GameCube disc",
    "psx-normalized-track-set": "normalized PlayStation disc tracks",
    "file-set-member": "file in set",
    "disc-set-member": "disc in set",
  };
  return Object.hasOwn(labels, value) ? labels[value] : "file scope unavailable";
}

function rejectionReason(reason: string) {
  const messages: Record<string, string> = {
    missing: "file not found",
    unreadable: "file couldn't be read",
    changed: "file changed since it was added",
    known_mismatch: "file does not match the required edition",
    ambiguous_identity: "edition could not be identified",
    missing_tool: "required checking tool is unavailable",
    check_failed: "required file check failed",
    consent_required: "review and consent required",
  };
  return Object.hasOwn(messages, reason) ? messages[reason] : "see file details";
}
