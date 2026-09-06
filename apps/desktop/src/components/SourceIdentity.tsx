import { useState } from "react";
import { AlertTriangle, Check, Clipboard, ClipboardCheck, ExternalLink, HelpCircle, ShieldAlert } from "lucide-react";
import { copyText } from "../clipboard";
import type { DigestIdentity, ObservedSourceComponent, ObservedSourceDigest, SourceInspectionReport, SourceRepresentation } from "../types";
import { platformLabels } from "../view-model";
import { Icon } from "./ui";

export function SourceIdentityPanel({ report, openEvidence }: { report: SourceInspectionReport; openEvidence?: (evidenceId: string) => void }) {
  const inspection = report.inspection;
  const recognized = inspection?.assessment.classification.state === "recognized" ? inspection.assessment.classification.identity : undefined;
  const variant = report.expected_identity?.variants.find(candidate => candidate.id === recognized?.variant_id);
  const state = sourceDisplayState(report);
  return <section className="source-identity" aria-label={`Source identity for ${report.expected_identity?.label ?? report.profile_id}`}>
    <p className="sr-only" role="status">Source check complete: {state.label}. {report.summary}</p>
    <div className="source-identity-heading">
      <div><small>Source identity</small><strong>{report.expected_identity?.label ?? report.profile_id}</strong></div>
      <span className={`source-result ${state.tone}`} aria-label={`Source result: ${state.label}`}><Icon glyph={state.icon} size="sm" />{state.label}</span>
    </div>
    <p>{report.summary}</p>
    <dl className="source-identity-summary">
      <div><dt>Selected</dt><dd><code>{inspection?.path ?? report.registered?.path ?? "No file is registered"}</code></dd></div>
      <div><dt>Format</dt><dd>{formatLabel(report.expected_identity?.kind ?? "Not recorded")}</dd></div>
      <div><dt>Edition</dt><dd>{variant ? variantLabel(variant) : classificationLabel(report)}</dd></div>
      <div><dt>Admission</dt><dd>{admissionLabel(report)}</dd></div>
    </dl>
    {report.problem && <p className="source-problem" role="status"><Icon glyph={AlertTriangle} size="sm" />{report.problem.message}</p>}
    {report.applications.map(application => <ApplicationResult key={`${application.port_id}:${application.role}`} application={application} />)}
    <details className="source-technical">
      <summary data-focusable>Full identity and evidence</summary>
      <div className="source-technical-body">
        <IdentityDigests report={report} />
        <Qualification report={report} />
        {report.evidence.length > 0 && <section><h4>Reviewed evidence</h4><ul className="source-evidence-list">{report.evidence.map(evidence =>
          <li key={evidence.id}><span><strong>{evidence.authority}</strong><small>{evidence.claim}</small></span><button data-focusable className="small-control button-with-icon" onClick={() => openEvidence?.(evidence.id)} disabled={!openEvidence} aria-label={`Open reviewed evidence from ${evidence.authority}`}><Icon glyph={ExternalLink} size="sm" />Open</button></li>
        )}</ul></section>}
        <p className="source-boundary"><strong>Read-only check.</strong> Portcove calculated these values locally. It did not modify, normalize, move, or upload the selected files.</p>
      </div>
    </details>
    <p className="source-next"><strong>Next:</strong> {report.next_action}</p>
  </section>;
}

function ApplicationResult({ application }: { application: SourceInspectionReport["applications"][number] }) {
  const result = contractLabel(application.contract_result.state);
  const applicability = applicabilityLabel(application.release_applicability.state_code, application.contract_result.state);
  const exactAutomated = application.qualification.exact_records.filter(record => record.kind === "automated_lifecycle");
  const exactHandsOn = application.qualification.exact_records.filter(record => record.kind === "hands_on");
  return <section className="source-application" aria-label={`${application.port_name} ${application.role} requirement`}>
    <div><strong>{application.port_name} · {application.role === "bios" ? "BIOS" : "Game file"}</strong><span className={`source-contract contract-${application.contract_result.state}`}>{result}</span></div>
    <small>{application.contract.authority_ref}</small>
    <dl>
      <div><dt>Release applicability</dt><dd>{applicability}</dd></div>
      <div><dt>Exact automated evidence</dt><dd>{evidencePlatforms(exactAutomated) || "Not recorded"}</dd></div>
      <div><dt>Exact hands-on evidence</dt><dd>{evidencePlatforms(exactHandsOn) || "Not recorded"}</dd></div>
    </dl>
    {exactHandsOn.length === 0 && <p>Missing gameplay evidence does not block an otherwise admitted source.</p>}
  </section>;
}

function IdentityDigests({ report }: { report: SourceInspectionReport }) {
  const inspection = report.inspection;
  const recognized = inspection?.assessment.classification.state === "recognized" ? inspection.assessment.classification.identity : undefined;
  const variants = recognized ? report.expected_identity?.variants.filter(variant => variant.id === recognized.variant_id) ?? [] : report.expected_identity?.variants ?? [];
  return <section><h4>Calculated identity</h4>
    {inspection ? <>
      <DigestList label="Selected file" digests={inspection.observed_digests} calculated />
      {inspection.components.map(component => <ObservedComponent key={component.id} component={component} report={report} />)}
    </> : <p>No calculated identity is available.</p>}
    <h4>Expected identity</h4>
    {variants.length > 0 ? variants.map(variant => <div className="expected-variant" key={variant.id}><strong>{variantLabel(variant)}</strong>{variant.representations.map(representation => <ExpectedRepresentation key={representation.id} representation={representation} />)}</div>) : <p>Expected values: Missing from the active catalog.</p>}
  </section>;
}

function ExpectedRepresentation({ representation }: { representation: SourceRepresentation }) {
  const groups = expectedGroups(representation);
  return <div className="expected-representation"><span>{formatLabel(representation.kind)} · {representation.extensions.length ? representation.extensions.join(", ") : "No filename extension"}</span>
    {representationFacts(representation).map(fact => <small key={fact}>{fact}</small>)}
    {groups.length ? groups.map(group => <ExpectedDigestGroup key={group.label} label={group.label} identities={group.identities} />) : <p><strong>Expected SHA-256:</strong> Missing from reviewed evidence.</p>}
  </div>;
}

function ExpectedDigestGroup({ label, identities }: { label: string; identities: DigestIdentity[] }) {
  return <div className="digest-group"><small>{label}</small>{identities.length ? identities.map((identity, index) => <div key={`${identity.scope}:${index}`}>
    <DigestValue label="Expected SHA-256" scope={identity.scope} value={identity.sha256} />
    <DigestValue label="Expected SHA-1" scope={identity.scope} value={identity.sha1} />
    <DigestValue label="Expected CRC32" scope={identity.scope} value={identity.crc32} />
  </div>) : <p><strong>Expected SHA-256:</strong> Missing from reviewed evidence.</p>}</div>;
}

function ObservedComponent({ component, report }: { component: ObservedSourceComponent; report: SourceInspectionReport }) {
  const detail = [component.name, component.track_count != null ? `${component.track_count} tracks` : undefined, component.volume_id ? `Volume ${component.volume_id}` : undefined].filter(Boolean).join(" · ");
  const expected = expectedComponentIdentities(report, component.id);
  const result = componentMatch(component, expected);
  return <div className="observed-component"><span className={`source-contract ${result.tone}`}>{result.label}</span><DigestList label={`${formatLabel(component.kind)} · ${component.id}${detail ? ` · ${detail}` : ""}`} digests={component.digests} calculated /></div>;
}

function DigestList({ label, digests, calculated }: { label: string; digests: ObservedSourceDigest[]; calculated?: boolean }) {
  return <div className="digest-group"><small>{label}</small>{digests.length ? digests.map((digest, index) => <DigestValue key={`${digest.algorithm}:${digest.scope}:${index}`} label={`${calculated ? "Calculated" : "Expected"} ${digest.algorithm.toUpperCase()}`} scope={digest.scope} value={digest.value} />) : <p>No calculated hashes are available.</p>}</div>;
}

function DigestValue({ label, scope, value }: { label: string; scope: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <p className="digest-value missing"><strong>{label} · {formatLabel(scope)}</strong><span>Missing from reviewed evidence</span></p>;
  const copy = () => { void copyText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => setCopied(false)); };
  return <div className="digest-value"><strong>{label} · {formatLabel(scope)}</strong><code>{value}</code><button data-focusable className="icon-button" aria-label={`Copy ${label} for ${formatLabel(scope)}`} onClick={copy}><Icon glyph={copied ? ClipboardCheck : Clipboard} size="sm" /></button></div>;
}

function Qualification({ report }: { report: SourceInspectionReport }) {
  const legacyAutomated = new Set(report.applications.flatMap(application => application.qualification.legacy_automated_platforms));
  const legacyHandsOn = new Set(report.applications.flatMap(application => application.qualification.legacy_hands_on_platforms));
  return <section><h4>Qualification coverage</h4>
    <dl className="qualification-grid">
      <div><dt>Legacy port-wide automated</dt><dd>{platformList(legacyAutomated) || "Not recorded"}</dd></div>
      <div><dt>Legacy port-wide hands-on</dt><dd>{platformList(legacyHandsOn) || "Not recorded"}</dd></div>
      <div><dt>Registration identity</dt><dd>{report.legacy.registration_identity_not_recorded ? "Legacy registration · exact identity was not recorded" : "Structured observation recorded"}</dd></div>
      <div><dt>Variant-unspecified records</dt><dd>{report.legacy.variant_unspecified_records.length || "None"}</dd></div>
    </dl>
  </section>;
}

function expectedGroups(representation: SourceRepresentation): Array<{ label: string; identities: DigestIdentity[] }> {
  if ("identities" in representation) return [{ label: representation.id, identities: representation.identities }];
  if (representation.kind === "file-set") return representation.members.map(member => ({ label: `${member.label} · ${member.filenames.join(", ")}`, identities: member.identities }));
  if (representation.kind === "multi-disc-set") return representation.discs.map(disc => ({ label: `${disc.label} · ${disc.track_counts.join("/")} tracks`, identities: disc.identities }));
  return [];
}

function expectedComponentIdentities(report: SourceInspectionReport, componentId: string) {
  return report.expected_identity?.variants.flatMap(variant => variant.representations.flatMap(representation => {
    if (representation.kind === "file-set") return representation.members.filter(member => member.id === componentId).flatMap(member => member.identities);
    if (representation.kind === "multi-disc-set") return representation.discs.filter(disc => disc.id === componentId).flatMap(disc => disc.identities);
    return [];
  })) ?? [];
}

function componentMatch(component: ObservedSourceComponent, expected: DigestIdentity[]) {
  if (expected.length === 0) return { label: "Expected identity missing", tone: "contract-unreviewed_for_release" };
  const match = component.digests.some(observed => expected.some(identity => identity.scope === observed.scope && ({ sha1: identity.sha1, sha256: identity.sha256, crc32: identity.crc32 })[observed.algorithm]?.toLowerCase() === observed.value.toLowerCase()));
  return match ? { label: "Exact member match", tone: "contract-supported" } : { label: "Member doesn't match", tone: "contract-known_incompatible" };
}

function representationFacts(representation: SourceRepresentation) {
  if (representation.kind === "volume-id") return [`Volume IDs: ${representation.values.join(", ") || "Missing"}`, `Track counts: ${representation.track_counts.join(", ") || "Missing"}`];
  if (representation.kind === "pinned-validator") return [`Reviewed validator: ${representation.validator_contract_id}`];
  if (representation.kind === "informational-extension") return [`Evidence gap: ${representation.evidence_gap}`];
  return [];
}

function sourceDisplayState(report: SourceInspectionReport) {
  const known = {
    recognized_exact: { label: "Exact match", tone: "success", icon: Check },
    accepted_identity_unknown: { label: "Accepted · identity unknown", tone: "warning", icon: HelpCircle },
    source_changed: { label: "Doesn't match registered source", tone: "danger", icon: ShieldAlert },
    ambiguous_identity: { label: "Couldn't determine one edition", tone: "warning", icon: HelpCircle },
    selected_needs_checking: { label: "Selected · needs checking", tone: "warning", icon: HelpCircle },
    known_mismatch: { label: "Doesn't match", tone: "danger", icon: ShieldAlert },
    source_missing: { label: "Couldn't check · file missing", tone: "danger", icon: AlertTriangle },
    source_could_not_be_checked: { label: "Couldn't check", tone: "danger", icon: AlertTriangle },
    not_evaluated: { label: "Not evaluated", tone: "neutral", icon: HelpCircle },
  } as const;
  return known[report.state_code as keyof typeof known] ?? { label: formatLabel(report.state_code), tone: "neutral", icon: HelpCircle };
}

function classificationLabel(report: SourceInspectionReport) {
  const classification = report.inspection?.assessment.classification;
  if (!classification) return report.legacy.registration_identity_not_recorded ? "Legacy registration · not evaluated" : "Couldn't check";
  if (classification.state === "recognized") return classification.identity.variant_id;
  if (classification.state === "ambiguous") return `${classification.candidates.length} possible editions`;
  if (classification.state === "unrecognized") return "Unidentified edition";
  return "Not evaluated";
}

function admissionLabel(report: SourceInspectionReport) {
  const admission = report.inspection?.assessment.admission;
  if (!admission || admission.state === "not_evaluated") return "Not evaluated";
  if (admission.state === "rejected") return `Refused · ${formatLabel(admission.reason)}`;
  const labels = { exact_identity: "Admitted · exact identity", structural_checks: "Admitted · structural checks", informational_consent: "Admitted · informational consent", upstream_validator: "Admitted · upstream validator" };
  return labels[admission.mode];
}

function contractLabel(state: SourceInspectionReport["applications"][number]["contract_result"]["state"]) {
  return ({ supported: "Supported", recognized_not_listed: "Recognized · not listed", known_incompatible: "Known mismatch · refused", informational: "Informational requirement", unreviewed_for_release: "Not reviewed for this release", not_evaluated: "Not evaluated" })[state];
}

function applicabilityLabel(state: string, contract: SourceInspectionReport["applications"][number]["contract_result"]["state"]) {
  if (contract === "unreviewed_for_release") return "Not applicable to this release";
  return ({ artifact_bound: "Bound to this exact release artifact", upstream_release_bound: "Bound to the reviewed upstream release", not_rebound: "No release-specific binding is recorded" } as Record<string, string>)[state] ?? formatLabel(state);
}

function variantLabel(variant: NonNullable<SourceInspectionReport["expected_identity"]>["variants"][number]) {
  const details = [variant.region, variant.revision, ...variant.product_codes].filter(Boolean);
  return `${variant.title}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function evidencePlatforms(records: SourceInspectionReport["applications"][number]["qualification"]["exact_records"]) {
  return [...new Set(records.map(record => platformLabels[record.scope.platform]))].join(" · ");
}

function platformList(platforms: Set<keyof typeof platformLabels>) {
  return [...platforms].map(platform => platformLabels[platform]).join(" · ");
}

function formatLabel(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}
