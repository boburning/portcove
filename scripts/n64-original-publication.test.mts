import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readCatalogSource } from "./catalog-authoring.mts";
import {
  catalogObservationSources,
  catalogObservationScopeBinding,
  newCatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import observerConfig from "../release/upstream-observer.json" with { type: "json" };
import { readCatalogPublicationBundle } from "./release-catalog-inspection.mts";
import { n64PackagedInputLayout } from "./n64-original-binding-candidates.mts";
import { assembleReviewedPublication } from "./catalog-prepare-publication.mts";
import {
  managedN64OriginalProjection,
  projectVerifiedN64OriginalAmendment,
  verifyManagedN64OriginalProposal,
} from "./n64-original-publication.mts";

const id = "chameleon-twist-jp-recompiled";
const indexPath = "definitions/index.json";
const policyPath = "policy/official/" + id + ".json";
const launchPath = "policy/official/" + id + ".launch.json";
const platform = "windows-x86-64";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const target = (bytes: Buffer) => "sha256/" + hash(bytes) + ".json";

type Index = {
  definitions: { stable_id: string; revision: number; target: string }[];
  contents: { target: string; sha256: string; length: number }[];
};
type Entry = {
  revision: number;
  required_capabilities: { minimum_version: number; maximum_version: number }[];
  execution_contract: string;
  persistence_contract: string;
  source_contracts: string[];
  port: Record<string, unknown> & {
    platforms: string[];
    release: {
      curated: Record<
        string,
        { release_id: number; tag: string; sha256: string; commit_sha1: string }
      >;
    };
  };
};
type Projection = {
  catalog: {
    source_catalog: {
      evidence: Record<string, unknown>[];
      contracts: { id: string; evidence_ids: string[]; n64_recomp_inputs_v1?: unknown[] }[];
    };
  };
};
type Policy = {
  policy_revision: number;
  decision: {
    index_sha256: string;
    definition_sha256: string;
    definition_revision: number;
    repository_id: number;
  };
};

void test("managed N64 publication stages observed exact bytes inside the prior grant and reader ceiling", async () => {
  const bundlePath = fileURLToPath(
    new URL("../release/catalog-publication/bundle", import.meta.url),
  );
  const original = await readCatalogPublicationBundle(bundlePath, performance.now() + 5000);
  const catalogPath = fileURLToPath(new URL("../crates/portcove-core/catalog", import.meta.url));
  const authored = readCatalogSource(catalogPath);

  const index = JSON.parse(original.get(indexPath)!.toString()) as Index;
  const row = index.definitions.find((item) => item.stable_id === id)!;
  const entry = JSON.parse(original.get(row.target)!.toString()) as Entry;
  const catalog = {
    ...authored.catalog,
    ports: [...authored.catalog.ports, entry.port],
    listings: authored.directory.listings,
  };
  const oldProjection = original.get(entry.execution_contract)!;
  const originalProjection = JSON.parse(oldProjection.toString()) as Projection;
  const contractId = originalProjection.catalog.source_catalog.contracts[0]!.id;
  const legacyCurated = entry.port.release.curated[platform]!;
  const policy = JSON.parse(original.get(policyPath)!.toString()) as Policy;
  const binding = {
    upstream_ref: legacyCurated.tag,
    artifact_sha256: legacyCurated.sha256,
    game_id: "ChameleonTwistJP",
    rom_xxh3_64: "abcdef0123456789",
  };
  const amendment = {
    requires_reader: 11,
    repository_id: policy.decision.repository_id,
    source_commit: legacyCurated.commit_sha1,
    release_id: legacyCurated.release_id,
    release_tag: legacyCurated.tag,
    contract_id: contractId,
    n64_recomp_inputs_v1: [binding],
    packages: [
      {
        platform,
        artifact_sha256: legacyCurated.sha256,
        layout_sha256: n64PackagedInputLayout(entry.port, platform),
      },
    ],
    upstream_support_evidence: {
      id: "sample-upstream-evidence",
      role: "upstream_support",
      authority: "Rainchus/ChameleonTwist1-JP-Recomp",
      authority_ref: legacyCurated.commit_sha1,
      reviewed_at: "2026-11-20",
      claim: "Fixture for a declared original-file digest",
      immutable_url:
        "https://github.com/Rainchus/ChameleonTwist1-JP-Recomp/blob/" +
        legacyCurated.commit_sha1 +
        "/README.md",
      live_url: null,
    },
  };
  assert.throws(
    () => projectVerifiedN64OriginalAmendment(original, id, amendment),
    /prior managed reader range/iu,
  );

  // The real signed bundle has a capability-1 ceiling. Extend only this in-memory
  // fixture to exercise both a mixed reader grant and a future eligible grant.
  const prior = new Map(original);
  const replaceEntry = (files: Map<string, Buffer>, advance: boolean) => {
    const oldTarget = row.target;
    if (advance) entry.revision++;
    const entryBytes = json(entry);
    row.revision = entry.revision;
    row.target = target(entryBytes);
    index.contents = index.contents.filter((item) => item.target !== oldTarget);
    index.contents.push({
      target: row.target,
      sha256: hash(entryBytes),
      length: entryBytes.length,
    });
    const bytes = json(index);
    files.delete(oldTarget);
    files.set(indexPath, bytes);
    files.set(row.target, entryBytes);
    for (const { stable_id } of index.definitions) {
      const scopePath = "policy/official/" + stable_id + ".json";
      const nextPolicy = JSON.parse(files.get(scopePath)!.toString()) as Policy;
      nextPolicy.decision.index_sha256 = hash(bytes);
      if (advance) nextPolicy.policy_revision++;
      if (stable_id === id) {
        nextPolicy.decision.definition_revision = entry.revision;
        nextPolicy.decision.definition_sha256 = hash(entryBytes);
      }
      files.set(scopePath, json(nextPolicy));
      const assessmentPath = "policy/official/" + stable_id + ".launch.json";
      if (files.has(assessmentPath)) {
        const launch = JSON.parse(files.get(assessmentPath)!.toString()) as {
          revision: number;
          policy_sha256: string;
        };
        if (advance) launch.revision++;
        launch.policy_sha256 = hash(files.get(scopePath)!);
        files.set(assessmentPath, json(launch));
      }
    }
  };
  entry.required_capabilities[0]!.maximum_version = 11;
  replaceEntry(prior, false);
  assert.throws(
    () => projectVerifiedN64OriginalAmendment(prior, id, amendment),
    /prior managed reader range/iu,
  );
  entry.required_capabilities[0]!.minimum_version = 11;
  entry.required_capabilities[0]!.maximum_version = 12;
  replaceEntry(prior, false);
  const observerPolicy = {
    policyIdentity: "b".repeat(64),
    definitionHash: () => "c".repeat(64),
    staleAfterHours: observerConfig.stale_after_hours,
  };
  assert.throws(
    () => managedN64OriginalProjection(prior, id, catalog, null, observerPolicy),
    /checkpoint/iu,
  );
  const source = catalogObservationSources(catalog).sources.find((source) =>
    source.ports.some((port) => port.id === id && port.original_source_family === "n64-recomp"),
  )!;
  const now = Date.parse("2026-11-20T18:00:00Z");
  const staleAt = new Date(now - 12 * 3600000).toISOString();
  const facts = "a".repeat(64);
  const config = {
    ...observerConfig,
    format: 2,
    asset_scope: "core-channel-candidates" as const,
    policy_input_sha256: facts,
    port_id: id,
    repository: source.repository,
    repository_id: policy.decision.repository_id,
  };
  const checkpoint = newCatalogObserverCheckpoint();
  checkpoint.sources[source.key] = {
    repository: source.repository,
    repository_id: config.repository_id,
    attempted_sequence: 0,
    completed_at: staleAt,
    freshness_observed_at: staleAt,
    last_change_at: staleAt,
    change_intervals: 0,
    mean_change_interval_ms: null,
    next_due_at: null,
    result_sha256: facts,
    completed_scope_sha256: catalogObservationScopeBinding(source, observerPolicy),
    last_complete_facts_sha256: facts,
    last_complete_policies: source.ports.map((port) => ({
      port_id: port.id,
      catalog_definition_sha256:
        port.kind === "listing" ? port.definition_sha256 : observerPolicy.definitionHash(),
      repository_id: config.repository_id,
      facts_sha256: facts,
    })),
    retry_at: null,
    exception_key: null,
    selection_progress: null,
    policy_progress: null,
    current_config: config,
    last_complete_config: config,
    retired_configs: [],
  };
  assert.throws(
    () => managedN64OriginalProjection(prior, id, catalog, checkpoint, observerPolicy, now),
    /missing, stale or incomplete/iu,
  );
  checkpoint.sources[source.key]!.freshness_observed_at = new Date(now).toISOString();
  assert.throws(
    () => managedN64OriginalProjection(prior, id, catalog, checkpoint, observerPolicy, now),
    /does not supply one verified N64 amendment/iu,
  );
  const changedCatalog = {
    ...catalog,
    ports: catalog.ports.map((port) =>
      port.id === id ? { ...port, summary: "changed authored port" } : port,
    ),
  };
  assert.throws(
    () => managedN64OriginalProjection(prior, id, changedCatalog, checkpoint, observerPolicy, now),
    /missing, stale or incomplete/iu,
  );
  assert.throws(
    () =>
      managedN64OriginalProjection(
        prior,
        id,
        catalog,
        checkpoint,
        {
          ...observerPolicy,
          policyIdentity: "e".repeat(64),
        },
        now,
      ),
    /missing, stale or incomplete/iu,
  );
  assert.throws(
    () =>
      managedN64OriginalProjection(
        prior,
        id,
        catalog,
        checkpoint,
        {
          ...observerPolicy,
          definitionHash: () => "f".repeat(64),
        },
        now,
      ),
    /missing, stale or incomplete/iu,
  );
  assert.throws(
    () => projectVerifiedN64OriginalAmendment(prior, "harvest-moon-64-recomp", amendment),
    /target is missing/iu,
  );
  const wrong = structuredClone(amendment);
  wrong.packages[0]!.artifact_sha256 = "e".repeat(64);
  assert.throws(
    () => projectVerifiedN64OriginalAmendment(prior, id, wrong),
    /independently retained artifact/iu,
  );

  const implicitRoot = { ...entry.port };
  delete implicitRoot.runtime_subdirectory;
  assert.equal(
    n64PackagedInputLayout(implicitRoot, platform),
    n64PackagedInputLayout(entry.port, platform),
  );
  const held = new Map(prior);
  const heldPolicy = JSON.parse(prior.get(policyPath)!.toString()) as Policy;
  held.set(
    policyPath,
    json({
      ...heldPolicy,
      curated_transitions: { future_acceptance_lost: true, artifacts: [] },
    }),
  );
  assert.throws(
    () => projectVerifiedN64OriginalAmendment(held, id, amendment),
    /loss of future acceptance/iu,
  );

  const uncuratedSibling = new Map(prior);
  entry.port.platforms.push("linux-x86-64");
  const priorProjectionPath = entry.execution_contract;
  const mixed = JSON.parse(oldProjection.toString()) as Projection & {
    catalog: { ports: unknown[] };
  };
  mixed.catalog.ports = [entry.port];
  const mixedProjection = json(mixed);
  entry.execution_contract = entry.persistence_contract = target(mixedProjection);
  entry.source_contracts = [entry.execution_contract];
  uncuratedSibling.set(entry.execution_contract, mixedProjection);
  replaceEntry(uncuratedSibling, false);
  assert.throws(
    () => projectVerifiedN64OriginalAmendment(uncuratedSibling, id, amendment),
    /without an exact curated artifact/iu,
  );
  const sibling = "linux-x86-64";
  entry.port.release.curated[sibling] = {
    ...legacyCurated,
    platform: sibling,
  } as typeof legacyCurated;
  const sharedProjection = json(mixed);
  entry.execution_contract = entry.persistence_contract = target(sharedProjection);
  entry.source_contracts = [entry.execution_contract];
  uncuratedSibling.set(entry.execution_contract, sharedProjection);
  replaceEntry(uncuratedSibling, false);
  assert.throws(
    () => projectVerifiedN64OriginalAmendment(uncuratedSibling, id, amendment),
    /shared with an unproved platform/iu,
  );
  entry.port.platforms.pop();
  delete entry.port.release.curated[sibling];
  entry.execution_contract = entry.persistence_contract = priorProjectionPath;
  entry.source_contracts = [priorProjectionPath];
  replaceEntry(prior, false);

  const output = projectVerifiedN64OriginalAmendment(prior, id, amendment);
  assert.equal(output.reader, 11);
  const updated = JSON.parse(output.draft.toString()) as Projection;
  assert.deepEqual(updated.catalog.source_catalog.contracts[0]?.n64_recomp_inputs_v1, [binding]);
  assert.equal(updated.catalog.source_catalog.evidence.at(-1)?.id, "sample-upstream-evidence");
  assert.deepEqual(prior.get(entry.execution_contract), oldProjection);

  const edited = new Map(prior);
  const projectionTarget = target(output.draft);
  entry.source_contracts = [projectionTarget];
  entry.execution_contract = projectionTarget;
  entry.persistence_contract = projectionTarget;
  index.contents.push({
    target: projectionTarget,
    sha256: hash(output.draft),
    length: output.draft.length,
  });
  edited.set(projectionTarget, output.draft);
  replaceEntry(edited, true);
  const prepared = assembleReviewedPublication(prior, edited, id, output.draft);
  verifyManagedN64OriginalProposal(prior, prepared.files, id, 11);
  const incompatible = new Map(prepared.files);
  entry.required_capabilities[0]!.maximum_version = 11;
  replaceEntry(incompatible, true);
  assert.throws(
    () => verifyManagedN64OriginalProposal(prior, incompatible, id, 11),
    /widens existing/iu,
  );
  const scopeChange = new Map(prepared.files);
  const launch = JSON.parse(prepared.files.get(launchPath)!.toString()) as {
    assessments: unknown[];
  };
  launch.assessments.push({ fabricated: true });
  scopeChange.set(launchPath, json(launch));
  assert.throws(
    () => verifyManagedN64OriginalProposal(prior, scopeChange, id, 11),
    /widens existing/iu,
  );
});
