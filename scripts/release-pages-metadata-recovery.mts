import { mkdtemp, writeFile, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { capacityDigest, inspectCapacityOperation } from "./release-capacity.mts";
import {
  inspectPublishedMetadata,
  inspectMetadataRenewalDescriptor,
  inspectMetadataBootstrapDescriptor,
} from "./release-metadata-contract.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  refreshCapacityExecutor,
  recoverOwnedPublishedMetadata,
} from "./release-capacity-executor.mts";
import { recoverReleaseOpportunity } from "./release-coordinator-state.mts";
import {
  materializePublishedCompleteSite,
  requirePublishedCompleteSite,
  readPublicApplicationSiteMarker,
} from "./release-site-readback.mts";
import {
  prepareAuthenticatedMetadataRenewal,
  inspectPreparedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";

/** Inert association only. It cannot authenticate a descriptor or authorize a
 * seed. The actual caller below obtains current facts from the maintained Tough
 * verifier and independently rechecks the complete public generation. */
export function inspectSettledPagesMetadataHandoff(input: Record<string, unknown>) {
  const capacity =
    isRecord(input.controller) && isRecord(input.controller.capacity_attempt)
      ? input.controller.capacity_attempt
      : null;
  const operation = capacity ? inspectCapacityOperation(capacity.operation) : null;
  if (
    !operation?.site_expectation ||
    operation.outcome !== "recovered" ||
    !isRecord(operation.recovery) ||
    operation.recovery.resolution !== "effect-completed" ||
    operation.receipt_limit !== 1 ||
    operation.executor_identity?.role !== "site-publication" ||
    operation.completed_effects.length !== 1
  )
    return null;
  const expected = operation.site_expectation;
  const effect = operation.completed_effects[0]!;
  if (
    effect.remote_identity !== `github-pages:boburning/portcove:${expected.site_generation_sha256}`
  )
    throw new Error("settled Pages receipt differs from durable generation");
  const seed = inspectPublishedMetadata(input.published_metadata);
  if (seed?.publication.site_generation_sha256 === expected.site_generation_sha256) {
    if (
      seed.repository_sha256 !== expected.repository_sha256 ||
      seed.root_sha256 !== expected.root_sha256 ||
      seed.operation_id !== operation.id
    )
      throw new Error("completed Pages handoff contradicts existing published state");
    return null;
  }
  if (seed) {
    if (
      seed.publication.site_generation_sha256 !== expected.prior_site_generation_sha256 ||
      seed.root_sha256 !== expected.root_sha256
    )
      throw new Error("settled Pages handoff does not advance the exact old published seed");
  } else {
    const bootstrap = inspectMetadataBootstrapDescriptor(input.metadata_bootstrap);
    if (
      expected.prior_site_generation_sha256 !== null ||
      !operation.metadata_bootstrap ||
      operation.metadata_bootstrap.descriptor_sha256 !== capacityDigest(bootstrap) ||
      bootstrap.root_sha256 !== expected.root_sha256
    )
      throw new Error("initial Pages readback lacks the exact already-settled bootstrap intent");
  }
  return { operation, expected, effect, seed };
}

/** Pure formatting/association, never a verifier. Only CURRENT authenticated
 * prior-feed facts are used; generated next versions are deliberately ignored. */
export function publishedPagesMetadataFromCurrentFacts(
  raw: unknown,
  handoff: NonNullable<ReturnType<typeof inspectSettledPagesMetadataHandoff>>,
) {
  const descriptor = inspectMetadataRenewalDescriptor(raw);
  if (
    descriptor.root_sha256 !== handoff.expected.root_sha256 ||
    descriptor.prior_repository_sha256 !== handoff.expected.repository_sha256
  )
    throw new Error("authenticated current feed differs from exact Pages intent");
  return inspectPublishedMetadata({
    schema_version: 1,
    root_sha256: descriptor.root_sha256,
    offline_targets_sha256: descriptor.offline_targets_sha256,
    repository_sha256: descriptor.prior_repository_sha256,
    timestamp_sha256: descriptor.prior_timestamp_sha256,
    snapshot_sha256: descriptor.prior_snapshot_sha256,
    records_sha256: descriptor.unchanged_records_sha256,
    versions: descriptor.current_versions,
    expires: descriptor.current_expires,
    operation_id: handoff.operation.id,
    publication: {
      remote_identity: handoff.effect.remote_identity,
      evidence_sha256: handoff.effect.evidence_sha256,
      site_generation_sha256: handoff.expected.site_generation_sha256,
    },
  })!;
}

/** Existing coordinator journal handoff only: no signing, version allocation,
 * context upload or Pages POST. The renewal preparer authenticates the current
 * public feed using the fixed verified tool/root; its unused successor plan is
 * retained as diagnostic data and never published or passed to a role job. */
export async function recoverPublishedPagesMetadata(
  executor: Parameters<typeof recoverOwnedPublishedMetadata>[0],
  raw: Parameters<typeof recoverOwnedPublishedMetadata>[1],
  toolsReceipt: object,
  privateParent: string,
  phaseDeadline: number,
  freshBoundary: () => Promise<void>,
) {
  const check = () => {
    if (!Number.isFinite(phaseDeadline) || performance.now() >= phaseDeadline)
      throw new Error("Pages metadata recovery deadline exhausted");
  };
  check();
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  const identity = await refreshCapacityExecutor(executor);
  if (
    identity.role !== "coordinator" ||
    identity.controller_revision !== tools.identity.controller_revision ||
    identity.execution_ref !== tools.identity.controller_ref
  )
    throw new Error("actual same-source coordinator tools/executor required");
  if (!path.isAbsolute(privateParent))
    throw new Error("private Pages metadata recovery parent required");
  const parent = await lstat(privateParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(privateParent)) !== path.resolve(privateParent)
  )
    throw new Error("private Pages metadata recovery parent is linked");
  check();
  const directory = await mkdtemp(path.join(privateParent, "pages-metadata-readback-"));
  try {
    await freshBoundary();
    const result = await withCoordinatorDeadline(phaseDeadline, () =>
      recoverOwnedPublishedMetadata(executor, raw, async (actualOperation) => {
        const current = await recoverReleaseOpportunity(raw.repository, raw.checkpoint);
        const handoff = inspectSettledPagesMetadataHandoff(current.input);
        if (!handoff || capacityDigest(handoff.operation) !== capacityDigest(actualOperation))
          throw new Error("exact settled Pages checkpoint/operation changed");
        const provider = createPagesProviderTransport(directory, {}, phaseDeadline);
        const expected = {
          artifact_id: handoff.expected.artifact_id,
          generation: handoff.expected.site_generation_sha256,
          controller_revision: handoff.operation.executor_identity!.controller_revision,
        };
        if (provider.observeByGeneration(expected).status !== "succeed")
          throw new Error("settled Pages provider completion unavailable");
        const acquired = await materializePublishedCompleteSite(
          {
            site_generation_sha256: handoff.expected.site_generation_sha256,
            root_sha256: handoff.expected.root_sha256,
            repository_sha256: handoff.expected.repository_sha256,
          },
          directory,
          phaseDeadline,
        );
        const site = await requirePublishedCompleteSite(acquired.receipt);
        const verifierSha = createHash("sha256")
          .update(await readControllerToolFile(tools.rust, 128 * 1024 * 1024))
          .digest("hex");
        const verified = await prepareAuthenticatedMetadataRenewal({
          verifier: tools.rust,
          verifier_sha256: verifierSha,
          trusted_root: site.root_path,
          trusted_root_sha256: site.pins.root_sha256,
          previous_repository: site.application,
          prior_repository_sha256: site.pins.repository_sha256,
          generated_at: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
          output_parent: directory,
          deadline: phaseDeadline,
        });
        const currentFacts = await inspectPreparedMetadataRenewal(verified);
        const published = publishedPagesMetadataFromCurrentFacts(currentFacts.descriptor, handoff);
        await verifiedControllerToolPaths(toolsReceipt);
        await requirePublishedCompleteSite(acquired.receipt);
        await inspectPreparedMetadataRenewal(verified);
        await readPublicApplicationSiteMarker(site.generation, phaseDeadline);
        if (provider.observeByGeneration(expected).status !== "succeed")
          throw new Error("Pages provider changed during current-feed verification");
        await writeFile(
          path.join(directory, "current-publication.json"),
          JSON.stringify({
            operation_id: handoff.operation.id,
            published,
            verified_current_descriptor: currentFacts.descriptor,
            scope: "actual current public feed; unused next plan not published",
            provider_mutations: 0,
            authority: "none",
          }),
          { flag: "wx", mode: 0o600 },
        );
        await freshBoundary();
        check();
        return published;
      }),
    );
    check();
    await writeFile(path.join(directory, "handoff.json"), JSON.stringify(result), {
      flag: "wx",
      mode: 0o600,
    });
    return { directory, ...result, provider_mutations: 0, authority: "none" as const };
  } catch (error) {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        outcome: "handoff-unresolved-or-ambiguous",
        automatic_retry: false,
        provider_mutations: 0,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`current Pages metadata handoff stopped; retain ${directory}`, {
      cause: error,
    });
  }
}
