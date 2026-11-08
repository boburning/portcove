import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { readApplicationPriorPublication } from "./application-release-feed.mts";
import {
  immutableApplicationBootstrap,
  retainedServedRenewal,
} from "./application-release-run.mts";
import {
  createApplicationFeedReader,
  readActualApplicationPagesState,
} from "./application-release-site.mts";
import { fixedReleaseReaderToken } from "./release-readonly-child-environment.mts";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import type { CatalogCoordinatorRefusalStage } from "./release-control-step-bridge.mts";
import {
  inspectTufPublicationFacts,
  standaloneBootstrapAdoption,
  standaloneBootstrapRenewalAdoption,
} from "./release-metadata-contract.mts";
import {
  inspectPreparedMetadataRenewal,
  prepareAuthenticatedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import {
  materializePublishedApplicationComponent,
  readPublicApplicationSite,
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

const retainedAssembly = {
  producer: {
    id: "42452784395",
    control_commit: "8a3bbbba04c2f67f4f1654efef44d0a6186e8410",
    control_ref: retainedServedRenewal.next_ref,
  },
  prior_repository_sha256: "c4017f8aba6b1fce353eb005564e23d909bd72bd6133d1ef840741929839f38b",
  context_sha256: "fdd0c0dc4b956383a56f21994a8fc4815b091c16ffc480c1291e3553e479bb15",
  metadata_sha256: "f5a7c25de4a4f3d3799c566e0b1c6af71ae1af674e4c51a67aa17e2f39999039",
  site_sha256: "5d7861c34626e422a0b8e613cf5da603bfc1fd439946857dfba436d127b0aef3",
} as const;

type ActualPublication = Awaited<ReturnType<typeof readApplicationPriorPublication>>;

/** This only selects an already authenticated cohort. Live provider and public
 * readback are required at the adoption entry point below. */
export function assertRetainedBootstrapRenewal({ discovered, prior }: ActualPublication) {
  assert.equal(discovered.release_id, retainedServedRenewal.release_id);
  assert.equal(discovered.custody.opportunity, retainedServedRenewal.opportunity);
  assert.equal(discovered.custody.source, retainedServedRenewal.source);
  assert.equal(discovered.custody.preparation, null);
  assert.equal(discovered.execution.run.control_ref, standaloneBootstrapRenewalAdoption.feed_ref);
  assert.equal(discovered.execution.attempt, 1);
  assert.equal(discovered.execution.conclusion, "success");
  assert.notEqual(discovered.execution.run.id, retainedAssembly.producer.id);
  assert.deepEqual(
    discovered.custody.runs.filter(
      ({ control_ref }) => control_ref === standaloneBootstrapRenewalAdoption.feed_ref,
    ),
    [discovered.execution.run],
  );
  assert.equal(
    discovered.state.log_url,
    `https://github.com/boburning/portcove/actions/runs/${discovered.execution.run.id}/job/${discovered.execution.job_id}`,
  );
  assert.deepEqual(prior.receipt.producer, retainedAssembly.producer);
  assert.equal(prior.receipt.producer_attempt, 1);
  assert.equal(prior.receipt.site.previous_generation, standaloneBootstrapAdoption.generation);
  assert.equal(prior.receipt.site.generation, standaloneBootstrapRenewalAdoption.generation);
  assert.equal(
    digest(prior.receipt.publication),
    standaloneBootstrapRenewalAdoption.publication_sha256,
  );
  assert.ok(isRecord(prior.metadata));
  assert.equal(prior.metadata.purpose, "metadata-renewal");
  assert.equal(prior.metadata.prior_generation, standaloneBootstrapAdoption.generation);
  assert.equal(prior.metadata.prior_repository_sha256, retainedAssembly.prior_repository_sha256);
  assert.equal(prior.metadata.context_sha256, retainedAssembly.context_sha256);
  const zip = prior.assets.find(({ name }) => name === "application-site.zip");
  const metadata = prior.assets.find(({ name }) => name === "application-metadata.json");
  assert.equal(prior.assets.length, 2);
  assert.ok(zip && metadata);
  assert.equal(zip.id, 723074720);
  assert.equal(zip.sha256, retainedAssembly.site_sha256);
  assert.equal(metadata.sha256, retainedAssembly.metadata_sha256);
}

async function assertSettledRenewalFeed(
  discovered: ActualPublication["discovered"],
  deadline: number,
) {
  const read = await createApplicationFeedReader(fixedReleaseReaderToken(), deadline);
  const actor = discovered.execution.run;
  const repository = "repos/boburning/portcove";
  const run = await read(`${repository}/actions/runs/${actor.id}/attempts/1`);
  const ref = await read(
    `${repository}/git/ref/${standaloneBootstrapRenewalAdoption.feed_ref.slice("refs/".length)}`,
  );
  assert.equal(run.status, 200);
  assert.ok(isRecord(run.body));
  assert.equal(run.body.id, Number(actor.id));
  assert.equal(run.body.run_attempt, 1);
  assert.equal(run.body.head_sha, actor.control_commit);
  assert.equal(
    run.body.head_branch,
    standaloneBootstrapRenewalAdoption.feed_ref.slice("refs/tags/".length),
  );
  assert.equal(run.body.status, "completed");
  assert.equal(run.body.conclusion, "success");
  assert.equal(run.body.display_title, `Application ${retainedServedRenewal.opportunity}`);
  assert.equal(ref.status, 200);
  assert.ok(isRecord(ref.body) && isRecord(ref.body.object));
  assert.equal(ref.body.ref, standaloneBootstrapRenewalAdoption.feed_ref);
  assert.equal(ref.body.object.type, "commit");
  assert.equal(ref.body.object.sha, actor.control_commit);
}

/** Read an appointed standalone publication. This returns no journal
 * write capability. Its owning caller still authenticates the journal CAS. */
export async function authenticateStandaloneBootstrapAdoption(
  directory: string,
  tools: object,
  deadline: number,
  stage: (value: CatalogCoordinatorRefusalStage<"operation">) => void = () => {},
) {
  const originalSelection = standaloneBootstrapAdoption;
  const original = immutableApplicationBootstrap;
  const actual = await readApplicationPriorPublication(directory);
  const { discovered, prior } = actual;
  const renewal = discovered.release_id === retainedServedRenewal.release_id;
  const selected = renewal ? standaloneBootstrapRenewalAdoption : originalSelection;
  if (renewal) {
    assertRetainedBootstrapRenewal(actual);
    await assertSettledRenewalFeed(discovered, deadline);
  } else {
    assert.equal(discovered.release_id, original.release_id);
    assert.equal(discovered.custody.opportunity, original.opportunity);
    assert.equal(discovered.custody.preparation, null);
    assert.deepEqual(discovered.execution.run, {
      id: originalSelection.run_id,
      control_commit: originalSelection.revision,
      control_ref: originalSelection.ref,
    });
    assert.equal(discovered.execution.attempt, originalSelection.attempt);
    assert.equal(discovered.execution.job_id, originalSelection.feed_job_id);
    assert.equal(discovered.execution.conclusion, "failure");
    assert.deepEqual(prior.receipt.producer, {
      id: original.assembly.run_id,
      control_commit: original.assembly.control_commit,
      control_ref: original.assembly.control_ref,
    });
    assert.equal(prior.receipt.producer_attempt, original.assembly.producer_attempt);
  }
  const facts = inspectTufPublicationFacts(prior.receipt.publication);
  assert.equal(digest(facts), selected.publication_sha256);
  assert.ok(typeof facts.root_sha256 === "string");
  assert.ok(typeof facts.repository_sha256 === "string");
  assert.equal(prior.receipt.site.generation, selected.generation);

  stage("standalone-application-bootstrap-site");
  const completeSite = renewal
    ? await readPublicApplicationSite(prior.receipt.site, deadline)
    : undefined;
  const site = await materializePublishedApplicationComponent(
    {
      site_generation_sha256: selected.generation,
      root_sha256: facts.root_sha256,
      repository_sha256: facts.repository_sha256,
    },
    directory,
    deadline,
  );
  stage("standalone-application-bootstrap-TUF");
  const { rust } = await verifiedControllerToolPaths(tools);
  // Keep the authenticated public input separate from mutable renewal work.
  const renewalParent = await mkdtemp(path.join(directory, "bootstrap-renewal-"));
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
    output_parent: renewalParent,
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
  stage("standalone-application-bootstrap-recheck");
  await assertCurrent();
  return {
    assertCurrent,
    metadata: {
      ...facts,
      operation_id: null,
      standalone_bootstrap_run: discovered.execution.run.id,
      publication: {
        remote_identity: discovered.state.log_url,
        evidence_sha256: digest({
          actor: discovered.execution,
          public_application: site.receipt,
          publication: facts,
          ...(completeSite ? { complete_site_sha256: completeSite.evidence_sha256 } : {}),
        }),
        site_generation_sha256: selected.generation,
      },
    },
  };
}
