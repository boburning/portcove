import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readApplicationPriorPublication } from "./application-release-feed.mts";
import { immutableApplicationBootstrap } from "./application-release-run.mts";
import { readActualApplicationPagesState } from "./application-release-site.mts";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  inspectTufPublicationFacts,
  standaloneBootstrapAdoption,
} from "./release-metadata-contract.mts";
import {
  inspectPreparedMetadataRenewal,
  prepareAuthenticatedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import {
  materializePublishedApplicationComponent,
  readPublicApplicationSiteMarker,
} from "./release-site-readback.mts";

/** This checks the current authenticated coordinator observation; the
 * historical journal counters remain untouched by the app-only import. */
export function assertStandaloneBootstrapAdoptionCapacity(observation: unknown) {
  if (
    !isRecord(observation) ||
    observation.phase !== "coordinator" ||
    observation.purpose !== "catalog-coordinator-controls" ||
    observation.resource_policy_matches_controller !== true ||
    !isRecord(observation.capacity_source) ||
    !isRecord(observation.capacity_source.report) ||
    observation.capacity_source.report.eligibility !== "eligible"
  )
    throw new Error("current catalog capacity is ineligible for standalone bootstrap adoption");
}

/** Read the single appointed standalone publication. This returns no journal
 * write capability. Its owning caller still authenticates the journal CAS. */
export async function authenticateStandaloneBootstrapAdoption(
  directory: string,
  tools: object,
  deadline: number,
) {
  const selected = standaloneBootstrapAdoption;
  const original = immutableApplicationBootstrap;
  const { discovered, prior } = await readApplicationPriorPublication(directory);
  assert.equal(discovered.release_id, original.release_id);
  assert.equal(discovered.custody.opportunity, original.opportunity);
  assert.equal(discovered.custody.preparation, null);
  assert.deepEqual(discovered.execution.run, {
    id: selected.run_id,
    control_commit: selected.revision,
    control_ref: selected.ref,
  });
  assert.equal(discovered.execution.attempt, selected.attempt);
  assert.equal(discovered.execution.job_id, selected.feed_job_id);
  assert.equal(discovered.execution.conclusion, "failure");
  assert.deepEqual(prior.receipt.producer, {
    id: original.assembly.run_id,
    control_commit: original.assembly.control_commit,
    control_ref: original.assembly.control_ref,
  });
  assert.equal(prior.receipt.producer_attempt, original.assembly.producer_attempt);
  const facts = inspectTufPublicationFacts(prior.receipt.publication);
  assert.equal(digest(facts), selected.publication_sha256);
  assert.ok(typeof facts.root_sha256 === "string");
  assert.ok(typeof facts.repository_sha256 === "string");
  assert.equal(prior.receipt.site.generation, selected.generation);

  const site = await materializePublishedApplicationComponent(
    {
      site_generation_sha256: selected.generation,
      root_sha256: facts.root_sha256,
      repository_sha256: facts.repository_sha256,
    },
    directory,
    deadline,
  );
  const { rust } = await verifiedControllerToolPaths(tools);
  const verification = await prepareAuthenticatedMetadataRenewal({
    initial_root_profile: "single-owner-one-of-one-v1",
    verifier: rust,
    verifier_sha256: createHash("sha256")
      .update(await readControllerToolFile(rust, 128 * 1024 * 1024))
      .digest("hex"),
    trusted_root: site.root_path,
    trusted_root_sha256: facts.root_sha256,
    previous_repository: site.directory,
    prior_repository_sha256: facts.repository_sha256,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    output_parent: directory,
    deadline,
  });
  const { descriptor } = await inspectPreparedMetadataRenewal(verification);
  assert.equal(descriptor.offline_targets_sha256, facts.offline_targets_sha256);
  assert.equal(descriptor.prior_timestamp_sha256, facts.timestamp_sha256);
  assert.equal(descriptor.prior_snapshot_sha256, facts.snapshot_sha256);
  assert.equal(descriptor.unchanged_records_sha256, facts.records_sha256);
  assert.deepEqual(descriptor.current_versions, facts.versions);
  assert.deepEqual(descriptor.current_expires, facts.expires);
  const assertCurrent = async () => {
    assert.deepEqual(await readActualApplicationPagesState(deadline), discovered.state);
    await readPublicApplicationSiteMarker(prior.receipt.site, deadline);
    assert.deepEqual(await readActualApplicationPagesState(deadline), discovered.state);
    assert.ok(
      Object.values(facts.expires).every((expiration) => Date.parse(expiration) > Date.now()),
    );
  };
  await assertCurrent();
  return {
    assertCurrent,
    metadata: {
      ...facts,
      operation_id: null,
      standalone_bootstrap_run: selected.run_id,
      publication: {
        remote_identity: discovered.state.log_url,
        evidence_sha256: digest({
          actor: discovered.execution,
          public_application: site.receipt,
          publication: facts,
        }),
        site_generation_sha256: selected.generation,
      },
    },
  };
}
