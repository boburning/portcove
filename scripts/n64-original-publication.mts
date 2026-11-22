import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { upstreamFacts } from "./maintenance-upstream.mts";
import {
  catalogObservationSources,
  catalogObservationScopeBinding,
  validateCatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import { n64PackagedInputLayout } from "./n64-original-binding-candidates.mts";
import { isRecord } from "./runtime-values.mts";

import type { CatalogObservationScopePolicy } from "./catalog-upstream-observer.mts";

type Files = ReadonlyMap<string, Buffer>;
type RecordValue = Record<string, unknown>;
const template = "n64-recomp-portable";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-fA-F0-9]{64}$/u.test(value);

function record(value: unknown): RecordValue {
  if (!isRecord(value)) throw new Error("Expected an exact managed publication record");
  return value;
}

function records(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw new Error("Expected an exact managed publication collection");
  return (value as unknown[]).map(record);
}

function one(rows: RecordValue[], matches: (row: RecordValue) => boolean) {
  const found = rows.filter(matches);
  if (found.length !== 1) throw new Error("Managed original-input target is missing or ambiguous");
  return found[0]!;
}

function jsonFile(files: Files, path: unknown, checksumAddressed = false) {
  if (typeof path !== "string") throw new Error("Managed publication target is missing");
  const bytes = files.get(path);
  if (!bytes || (checksumAddressed && path !== "sha256/" + digest(bytes) + ".json"))
    throw new Error("Managed publication target bytes do not match");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return { value: record(value), bytes };
}

function managedN64Entry(files: Files, portId: string) {
  const index = jsonFile(files, "definitions/index.json");
  const row = one(
    records(index.value.definitions),
    (entry) => entry.namespace === "official" && entry.stable_id === portId,
  );
  const { value: entry, bytes } = jsonFile(files, row.target, true);
  const policy = jsonFile(files, "policy/official/" + portId + ".json").value;
  const decision = record(policy.decision);
  const port = record(entry.port);
  const projection = jsonFile(files, entry.execution_contract, true).value;
  if (
    entry.namespace !== "official" ||
    entry.stable_id !== portId ||
    entry.revision !== row.revision ||
    policy.policy_schema !== 4 ||
    policy.namespace !== "official" ||
    policy.stable_id !== portId ||
    decision.status !== "managed_github" ||
    decision.template !== template ||
    decision.index_sha256 !== digest(index.bytes) ||
    decision.definition_sha256 !== digest(bytes) ||
    decision.definition_revision !== row.revision ||
    decision.curated_acquisition_checks !== 1 ||
    decision.scoped_launch_checks !== 1 ||
    port.adapter !== template ||
    port.id !== portId ||
    entry.execution_contract !== entry.persistence_contract ||
    !isDeepStrictEqual(entry.source_contracts, [entry.execution_contract]) ||
    projection.representation !== "catalog_projection"
  )
    throw new Error("Original-input preparation requires a prior exact curated managed grant");
  const graph = record(projection.catalog);
  if (!isDeepStrictEqual(graph.ports, [port]))
    throw new Error("Retained projection differs from the managed port");
  return { entry, policy, decision, port, projection, graph };
}

function currentAmendment(
  checkpoint: unknown,
  catalog: unknown,
  portId: string,
  policy: CatalogObservationScopePolicy,
  now: number,
) {
  const state = validateCatalogObserverCheckpoint(checkpoint, now);
  const source = catalogObservationSources(catalog).sources.find((item) =>
    item.ports.some((port) => port.id === portId && port.original_source_family === "n64-recomp"),
  );
  const progress = source ? state.sources[source.key] : undefined;
  const freshness = progress?.freshness_observed_at;
  const staleAfterHours = policy.staleAfterHours;
  const currentScope = source ? catalogObservationScopeBinding(source, policy) : undefined;
  if (
    !source ||
    !progress ||
    typeof freshness !== "string" ||
    !Number.isFinite(staleAfterHours) ||
    staleAfterHours <= 0 ||
    now - Date.parse(freshness) >= staleAfterHours * 3600000 ||
    progress.completed_at === null ||
    progress.completed_scope_sha256 !== currentScope ||
    progress.last_complete_facts_sha256 === null ||
    progress.exception_key !== null ||
    (progress.selection_progress !== null &&
      (progress.selection_progress.binding !== progress.completed_scope_sha256 ||
        progress.selection_progress.cursor !== source.ports.length)) ||
    progress.policy_progress !== null ||
    !progress.current_config ||
    progress.current_config.stale_after_hours !== staleAfterHours ||
    !isDeepStrictEqual(progress.current_config, progress.last_complete_config) ||
    progress.last_complete_policies.length !== source.ports.length ||
    source.ports.some((port, index) => {
      const retained = progress.last_complete_policies[index];
      return (
        retained?.port_id !== port.id ||
        retained.catalog_definition_sha256 !==
          (port.kind === "listing" ? port.definition_sha256 : policy.definitionHash(port.id))
      );
    })
  )
    throw new Error("Current observer source completion is missing, stale or incomplete");

  // The projector checks the exact current release/platform selections and the
  // authored port and source-contract scope against the completed proof.
  const facts = record(upstreamFacts(state, catalog, now).facts.get("port:" + portId) ?? {});
  const matches = records(facts.sources ?? []).flatMap((item) =>
    item.source_key === source.key && isRecord(item.n64_original_contract_amendment)
      ? [item.n64_original_contract_amendment]
      : [],
  );
  if (matches.length !== 1)
    throw new Error("Current observer evidence does not supply one verified N64 amendment");
  return matches[0]!;
}

/** Prepare an inert graph delta over the retained managed port. The existing
 * publisher still authenticates prior history and the client still admits the
 * exact policy and curated bytes. A checkpoint cannot create either authority. */
export function managedN64OriginalProjection(
  prior: Files,
  portId: string,
  catalog: unknown,
  checkpoint: unknown,
  policy: CatalogObservationScopePolicy,
  now = Date.now(),
) {
  return projectVerifiedN64OriginalAmendment(
    prior,
    portId,
    currentAmendment(checkpoint, catalog, portId, policy, now),
  );
}

function requireAdmittedReader(entry: RecordValue, reader: unknown): asserts reader is 10 | 11 {
  const requirement = one(
    records(entry.required_capabilities),
    ({ template: key }) => key === template,
  );
  const { minimum_version: minimum, maximum_version: maximum } = requirement;
  if (
    (reader !== 10 && reader !== 11) ||
    typeof minimum !== "number" ||
    !Number.isSafeInteger(minimum) ||
    typeof maximum !== "number" ||
    !Number.isSafeInteger(maximum) ||
    minimum < reader ||
    maximum < minimum
  )
    throw new Error("Prior managed reader range cannot carry this original-input amendment");
}

export function projectVerifiedN64OriginalAmendment(
  prior: Files,
  portId: string,
  amendment: RecordValue,
) {
  const { entry, policy, decision, port, projection, graph } = managedN64Entry(prior, portId);
  const reader = amendment.requires_reader;
  requireAdmittedReader(entry, reader);
  if (decision.repository_id !== amendment.repository_id)
    throw new Error("Observed repository differs from the retained approved repository");
  const release = record(port.release);
  const curated = record(release.curated);
  if (
    !Array.isArray(port.platforms) ||
    !(port.platforms as unknown[]).every((platform) => {
      const artifact = typeof platform === "string" ? curated[platform] : undefined;
      return (
        isRecord(artifact) &&
        artifact.platform === platform &&
        artifact.route === "github-release-asset" &&
        isDigest(artifact.sha256)
      );
    })
  )
    throw new Error("Retained platform without an exact curated artifact cannot be amended");
  const transitions =
    policy.curated_transitions === undefined ? undefined : record(policy.curated_transitions);
  if (transitions?.future_acceptance_lost === true)
    throw new Error("Retained curated grant reports loss of future acceptance");
  const statuses = transitions ? records(transitions.artifacts) : [];
  const packages = records(amendment.packages);
  if (packages.length === 0 || packages.length > 12) throw new Error("Missing exact package proof");
  for (const pkg of packages) {
    const platform = pkg.platform;
    const accepted = typeof platform === "string" ? curated[platform] : undefined;
    if (
      typeof platform !== "string" ||
      !Array.isArray(port.platforms) ||
      !port.platforms.includes(platform) ||
      !isRecord(accepted) ||
      accepted.platform !== platform ||
      accepted.repository !== release.repository ||
      accepted.route !== "github-release-asset" ||
      accepted.release_id !== amendment.release_id ||
      accepted.tag !== amendment.release_tag ||
      accepted.commit_sha1 !== amendment.source_commit ||
      !isDigest(accepted.sha256) ||
      accepted.sha256.toLowerCase() !== pkg.artifact_sha256 ||
      !isRecord(accepted.protected_acceptance) ||
      !isDigest(accepted.protected_acceptance.sha256) ||
      pkg.layout_sha256 !== n64PackagedInputLayout(port, platform)
    )
      throw new Error(
        "Package proof differs from the independently retained artifact or runtime layout",
      );
    if (
      statuses.some(
        (transition) =>
          transition.asset_id === accepted.asset_id && transition.status !== "cleared",
      )
    )
      throw new Error("Retained curated grant holds this exact package");
  }

  for (const [platform, artifact] of Object.entries(curated)) {
    if (
      isRecord(artifact) &&
      isDigest(artifact.sha256) &&
      packages.some((pkg) => pkg.artifact_sha256 === (artifact.sha256 as string).toLowerCase()) &&
      !packages.some((pkg) => pkg.platform === platform)
    )
      throw new Error("An accepted package is shared with an unproved platform");
  }

  const source = record(graph.source_catalog);
  const contract = one(records(source.contracts), ({ id }) => id === amendment.contract_id);
  if (
    contract.port_id !== portId ||
    contract.profile_id !== port.source_profile ||
    contract.role !== "game" ||
    (reader === 11
      ? contract.admission_mode !== "enforced"
      : contract.admission_mode !== "informational")
  )
    throw new Error("Observed original-input scope differs from the signed game source contract");
  const existing = records(contract.n64_recomp_inputs_v1 ?? []);
  // Preserve signed historical bindings, including where the bundled catalog has
  // yet to incorporate the already-delivered repair.
  const current = records(amendment.n64_recomp_inputs_v1).filter(
    (binding) =>
      binding.upstream_ref === amendment.release_tag &&
      packages.some((pkg) => pkg.artifact_sha256 === binding.artifact_sha256),
  );
  const currentDigests = new Set(current.map(({ artifact_sha256 }) => artifact_sha256));
  if (packages.some((pkg) => !currentDigests.has(pkg.artifact_sha256)))
    throw new Error("Observed original-input proof does not cover the accepted package");
  const next = [...existing];
  for (const binding of current) {
    const found = existing.find(
      (old) =>
        old.upstream_ref === binding.upstream_ref &&
        isDigest(old.artifact_sha256) &&
        old.artifact_sha256.toLowerCase() === binding.artifact_sha256,
    );
    if (!found) next.push(binding);
    else if (
      found.game_id !== binding.game_id ||
      typeof found.rom_xxh3_64 !== "string" ||
      found.rom_xxh3_64.toLowerCase() !== binding.rom_xxh3_64
    )
      throw new Error("An existing signed original-input binding conflicts with the observation");
  }
  if (next.length === existing.length || next.length > 64)
    throw new Error("No new bounded original-input bindings remain for publication");

  const supportEvidence = record(amendment.upstream_support_evidence);
  const priorEvidence = records(source.evidence);
  const sameId = priorEvidence.find(({ id }) => id === supportEvidence.id);
  if (sameId && !isDeepStrictEqual(sameId, supportEvidence))
    throw new Error("Signed upstream evidence identity already has another meaning");
  if (
    typeof supportEvidence.id !== "string" ||
    supportEvidence.role !== "upstream_support" ||
    supportEvidence.authority_ref !== amendment.source_commit ||
    !Array.isArray(contract.evidence_ids)
  )
    throw new Error("Source evidence cannot bind to the retained contract");
  if (!sameId) source.evidence = [...priorEvidence, supportEvidence];
  contract.evidence_ids = [
    ...new Set([...(contract.evidence_ids as unknown[]), supportEvidence.id]),
  ];
  contract.n64_recomp_inputs_v1 = next;

  return { draft: Buffer.from(JSON.stringify(projection)), reader };
}

export function verifyManagedN64OriginalProposal(
  prior: Files,
  candidate: Files,
  portId: string,
  reader: number,
) {
  const old = managedN64Entry(prior, portId);
  const next = managedN64Entry(candidate, portId);
  requireAdmittedReader(old.entry, reader);
  function expected(entry: RecordValue) {
    const {
      revision: _revision,
      execution_contract: _execution,
      persistence_contract: _persistence,
      source_contracts: _source,
      ...rest
    } = entry;
    return rest;
  }
  function scope(policy: RecordValue) {
    const { policy_revision: _revision, decision, ...identity } = policy;
    const {
      definition_sha256: _definition,
      definition_revision: _definitionRevision,
      index_sha256: _index,
      ...grant
    } = record(decision);
    return { ...identity, decision: grant };
  }
  function launch(files: Files) {
    const path = "policy/official/" + portId + ".launch.json";
    if (!files.has(path)) return;
    const {
      revision: _revision,
      policy_sha256: _policy,
      ...assessments
    } = jsonFile(files, path).value;
    return assessments;
  }
  if (
    !isDeepStrictEqual(expected(old.entry), expected(next.entry)) ||
    !isDeepStrictEqual(scope(old.policy), scope(next.policy)) ||
    !isDeepStrictEqual(launch(prior), launch(candidate))
  )
    throw new Error("Reviewed original-input proposal widens existing definition or grant");
}
