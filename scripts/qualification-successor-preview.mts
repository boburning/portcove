import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";

const rule = "managed-successor-preview-v1";
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const rows = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);

type RecordFields = Record<string, unknown>;

function exactScope(scope: unknown) {
  if (!isRecord(scope) || !isRecord(scope.variant) || !isRecord(scope.variant.identity))
    return null;
  const { game_id, variant_id, representation_id } = scope.variant.identity;
  const { port_id, platform, contract_id, check_version, upstream_ref, artifact_sha256 } = scope;
  return digest(artifact_sha256) &&
    scope.variant.state === "exact" &&
    [
      game_id,
      variant_id,
      representation_id,
      port_id,
      platform,
      contract_id,
      check_version,
      upstream_ref,
    ].every(nonempty)
    ? {
        port_id,
        platform,
        contract_id,
        check_version,
        game_id,
        variant_id,
        representation_id,
        upstream_ref,
        artifact_sha256,
      }
    : null;
}

function coordinates(value: unknown) {
  if (!isRecord(value)) return null;
  const { setup, launch, data } = value;
  return [setup, launch, data].every(digest) ? { setup, launch, data } : null;
}

function evidenceMatches(
  receipt: unknown,
  scope: unknown,
  kind: string,
  expectedCoordinates: unknown,
) {
  return (
    isRecord(receipt) &&
    receipt.kind === kind &&
    receipt.outcome === "passed" &&
    digest(receipt.evidence_sha256) &&
    isDeepStrictEqual(coordinates(receipt.coordinates), expectedCoordinates) &&
    isDeepStrictEqual(exactScope(receipt.scope), scope)
  );
}

function hasReviewedPass(
  records: RecordFields[],
  scope: ReturnType<typeof exactScope>,
  kind: string,
  evidenceIds: Set<unknown>,
) {
  return records.some(
    (record) =>
      record.kind === kind &&
      record.outcome === "passed" &&
      isDeepStrictEqual(exactScope(record.scope), scope) &&
      Array.isArray(record.evidence_ids) &&
      record.evidence_ids.length > 0 &&
      record.evidence_ids.every((id) => evidenceIds.has(id)),
  );
}

function evaluateCase(
  proposal: unknown,
  port: RecordFields,
  contract: RecordFields,
  platform: unknown,
  records: RecordFields[],
  evidenceIds: Set<unknown>,
) {
  if (!isRecord(proposal)) return { decision: "unassessed", reason: "successor_evidence_missing" };
  if (proposal.rule !== rule) return { decision: "refuse", reason: "preview_rule_changed" };
  const anchor = exactScope(proposal.anchor);
  const successor = exactScope(proposal.successor);
  if (!anchor || !successor) return { decision: "refuse", reason: "exact_scope_missing" };
  const { upstream_ref: anchorRef, artifact_sha256: anchorSha } = anchor;
  const nextRef = successor.upstream_ref;
  if (
    anchor.port_id !== port.id ||
    anchor.platform !== platform ||
    anchor.contract_id !== contract.id ||
    !Array.isArray(contract.supported_variant_ids) ||
    !contract.supported_variant_ids.includes(anchor.variant_id) ||
    !isDeepStrictEqual(anchor, {
      ...successor,
      upstream_ref: anchorRef,
      artifact_sha256: anchorSha,
    }) ||
    anchorRef === nextRef
  )
    return { decision: "refuse", reason: "scope_or_check_contract_changed" };
  if (
    !rows(contract.applicability).some(
      (binding) => binding.upstream_ref === anchorRef && binding.artifact_sha256 === anchorSha,
    )
  )
    return { decision: "refuse", reason: "anchor_release_binding_missing" };
  const supported = ["automated_lifecycle", "hands_on"].every((kind) =>
    hasReviewedPass(records, anchor, kind, evidenceIds),
  );
  if (
    records.some(
      (record) =>
        (record.kind === "known_failure" || record.outcome === "failed") &&
        [anchor, successor].some((scope) => isDeepStrictEqual(exactScope(record.scope), scope)),
    )
  )
    return { decision: "refuse", reason: "exact_known_failure" };
  if (!supported) return { decision: "refuse", reason: "exact_supported_anchor_missing" };
  const priorCoordinates = coordinates(proposal.anchor_coordinates);
  const nextCoordinates = coordinates(proposal.successor_coordinates);
  if (!priorCoordinates || !nextCoordinates)
    return { decision: "unassessed", reason: "coordinate_evidence_missing" };
  if (!isDeepStrictEqual(priorCoordinates, nextCoordinates))
    return { decision: "refuse", reason: "setup_launch_or_data_changed" };
  if (
    !isRecord(proposal.selection) ||
    proposal.selection.outcome !== "selected" ||
    !isDeepStrictEqual(proposal.selection.release_spec, port.release) ||
    !isDeepStrictEqual(exactScope(proposal.selection.scope), successor) ||
    !digest(proposal.selection.evidence_sha256)
  )
    return { decision: "refuse", reason: "exact_selector_evidence_missing_or_changed" };
  if (!evidenceMatches(proposal.admission, successor, "independent_admission", nextCoordinates))
    return { decision: "refuse", reason: "exact_successor_admission_missing" };
  if (!evidenceMatches(proposal.integrity, successor, "integrity", nextCoordinates))
    return { decision: "refuse", reason: "exact_successor_integrity_not_passed" };
  if (
    !evidenceMatches(proposal.lifecycle, successor, "automated_lifecycle", nextCoordinates) ||
    !hasReviewedPass(records, successor, "automated_lifecycle", evidenceIds)
  )
    return { decision: "refuse", reason: "exact_successor_lifecycle_not_passed" };
  return { decision: "eligible_for_review", inherited_from: anchorRef, candidate_ref: nextRef };
}

export function previewQualificationSuccessors(catalog: unknown, inputs: unknown = []) {
  if (!isRecord(catalog) || !isRecord(catalog.source_catalog) || !Array.isArray(catalog.ports))
    throw new Error("Successor preview requires the scoped operational catalog");
  const proposals = rows(inputs);
  if (!Array.isArray(inputs) || proposals.length !== inputs.length)
    throw new Error("Successor preview cases must be an array of reviewed records");
  const { source_catalog: source } = catalog;
  for (const table of [catalog.ports, source.qualification, source.evidence, source.contracts]) {
    if (!Array.isArray(table) || table.some((row) => !isRecord(row)))
      throw new Error("Successor preview requires complete catalog evidence tables");
  }
  const records = rows(source.qualification);
  const evidence = new Set(rows(source.evidence).map((row) => row.id));
  const ports = rows(catalog.ports);
  const contracts = rows(source.contracts).filter(
    (contract) =>
      contract.role === "game" &&
      contract.admission_mode === "enforced" &&
      contract.release_policy === "integration-contract-v1",
  );
  const used = new Set<unknown>();
  const candidates = contracts.flatMap((contract) => {
    const owners = ports.filter((port) => port.id === contract.port_id);
    if (owners.length !== 1) throw new Error("Catalog contains missing or ambiguous source owners");
    const port = owners[0]!;
    if (!Array.isArray(port.platforms) || !isRecord(port.release))
      throw new Error("Dynamic source owner has no declared platforms or release spec");
    return port.platforms.map((platform: unknown) => {
      const cases = proposals.filter(
        (input) =>
          input.port_id === port.id &&
          input.platform === platform &&
          input.contract_id === contract.id,
      );
      if (cases.length > 1) throw new Error("Duplicate successor preview case");
      if (cases.length) used.add(cases[0]);
      return {
        port_id: port.id,
        platform,
        contract_id: contract.id,
        ...evaluateCase(cases[0], port, contract, platform, records, evidence),
      };
    });
  });
  if (used.size !== proposals.length) throw new Error("Case is outside the preview population");
  return {
    rule,
    authority: "none",
    physical_and_human_evidence_inherited: false,
    operational_ports: ports.length,
    historical_supported_ports: ports.filter(
      (port) =>
        Array.isArray(port.platforms) &&
        Array.isArray(port.automated_tested_platforms) &&
        Array.isArray(port.manually_validated_platforms) &&
        port.platforms.some(
          (platform: unknown) =>
            (port.automated_tested_platforms as unknown[]).includes(platform) &&
            (port.manually_validated_platforms as unknown[]).includes(platform),
        ),
    ).length,
    scoped_records: records.length,
    scoped_hands_on_passes: records.filter(
      (record) => record.kind === "hands_on" && record.outcome === "passed",
    ).length,
    candidates,
  };
}

async function readReviewedJson(path: string) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size > 8 * 1024 * 1024)
    throw new Error("Successor preview accepts bounded regular JSON files");
  const bytes = await readFile(path);
  if (bytes.length !== entry.size) throw new Error("Successor preview input size changed");
  return {
    data: JSON.parse(bytes.toString("utf8")) as unknown,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function readQualificationSuccessorPreview(catalog: string, cases?: string) {
  const catalogInput = await readReviewedJson(catalog);
  const casesInput = cases === undefined ? null : await readReviewedJson(cases);
  return {
    catalog_sha256: catalogInput.sha256,
    cases_sha256: casesInput?.sha256 ?? null,
    ...previewQualificationSuccessors(catalogInput.data, casesInput?.data ?? []),
  };
}
