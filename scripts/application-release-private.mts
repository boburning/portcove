import { GitHubApiError } from "./github-operation.mts";
import { fixedReleaseToolDependencies } from "./release-tool-dependency-selection.mts";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import { nativeCompatibilitySourcePaths } from "./release-native-source-contract.mts";
/** Fixed trusted role commands, bundled on a separate secret-free runner.
 * Candidate packages remain data here. Only native acceptance jobs launch them. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";
import {
  applicationOutput,
  readApplicationJson,
  verifyApplicationRelease,
  receiveApplicationData,
  writeApplicationJson,
  sha256,
  applicationFileIdentity,
} from "./application-release-io.mts";
import {
  applicationReleaseTrust,
  applicationSourcePacketMaximumBytes,
  applicationReleaseMaximumMinutes,
  inspectApplicationSpendingAppointment,
  inspectApplicationReleaseExecution,
  verifyApplicationReleaseTrust,
} from "./application-release-policy.mts";
import { readApplicationJobBudget } from "./application-release-budget.mts";
import { readPublicationPauseWithSdk } from "./release-control-inputs.mts";
import { semanticReviewCheckName } from "./release-control-phases.mts";
import {
  readIndependentSemanticCheckInventoryWithSdk,
  selectLatestApplicationSemanticCheck,
} from "./release-semantic-disposition-reader.mts";
import {
  observeReleaseInputProtections,
  createApplicationProtectionObservationReader,
  requireApplicationReleaseProtectionDigest,
  bootstrapProtectionFingerprints,
} from "./release-input-protections.mts";
import {
  fixedReleaseReaderToken,
  readOnlyReleaseChildEnvironment,
  withReadOnlyReleaseChildren,
} from "./release-readonly-child-environment.mts";
import {
  payloadSigningEnvironment,
  preparePayloadSigningEnvironment,
} from "./release-payload-signing.mts";
import { receiveApplicationPackages } from "./application-release-transfer.mts";
import { createApplicationUpdaterInventory } from "./application-release-artifacts.mts";
import { loadPackagePolicy } from "./release-package-policy.mts";
import {
  receiveApplicationContext,
  inspectApplicationContextBeforeKey,
  prepareInitialApplicationContext,
  packApplicationContext,
  assertApplicationContextReservationHandoff,
  prepareApplicationReleaseContext,
  applicationContextPriorRepositorySha256,
  applicationMetadataContextIdentity,
  assertApplicationContextCurrentRecords,
  inspectApplicationBootstrapSource,
  inspectInitialApplicationDescriptor,
  inspectApplicationRenewalSource,
  assertApplicationRenewalContext,
  prepareApplicationMetadataRenewalContext,
} from "./application-release-context.mts";
import type { ApplicationContextReservationHandoff } from "./application-release-context.mts";
import { decodeTufRoleKey } from "./release-tuf-signing.mts";
import {
  materializeInitialApplicationRehearsal,
  readPublicApplicationSite,
  materializePublishedApplicationComponent,
  materializePublishedCompleteSite,
  readPublicApplicationSiteMarker,
} from "./release-site-readback.mts";
import { composeSiteFiles } from "./release-site-composer.mts";
import {
  assertMetadataBootstrapPublication,
  assertMetadataRenewalPublication,
  inspectTufPublicationFacts,
} from "./release-metadata-contract.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import {
  readImmutableBootstrapFeed,
  readApplicationImmutableFeed,
  verifyApplicationPagesArtifact,
  discoverActualPublishedApplicationCohort,
  createFixedApplicationReleaseAssetReader,
  readApplicationPriorPublication,
  readApplicationPendingLineage,
  assertApplicationForwardPreimage,
} from "./application-release-feed.mts";
import { projectWindowsNsisExecutable } from "./release-compiler-desktop.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  readActualApplicationPagesState,
  assertBootstrapPagesActor,
  executeBootstrapPages,
  applicationPagesIntent,
  readApplicationControllerPagesAdmissions,
  createApplicationFeedReader,
  readApplicationPagesExecution,
} from "./application-release-site.mts";
import { inspectSiteGeneration } from "./release-site-generation.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import type { PagesRequestEvidence } from "./release-pages-provider.mts";
import { performance } from "node:perf_hooks";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { setTimeout as pause } from "node:timers/promises";
import {
  applicationNativeHarness,
  applicationNativeFiles,
  inspectApplicationNativeAcceptance,
  inspectApplicationNativeProducerJob,
  readApplicationAttemptJobs,
  inspectApplicationPublicInstalledProducer,
  inspectApplicationPublicInstalledProof,
  inspectApplicationNativeAttempts,
  inspectApplicationNativeHost,
} from "./application-release-native.mts";
import type { ApplicationNativeBinding } from "./application-release-native.mts";
import { retainNativeSourceDeclarations } from "./release-native-source-provider.mts";
import {
  inspectBootstrapSiteArchive,
  publishApplicationMetadataRelease,
  bootstrapAssetNames,
  applicationDraftAssembly,
  applicationDraftProofBytes,
  applicationDraftProofName,
  readApplicationDraftRecoveryState,
  readExpiredApplicationDraftAssets,
  createApplicationAssetUploader,
  createApplicationMetadataPublicationProvider,
  createPreparedApplicationPublicationProvider,
  createPreparedApplicationPublicationReader,
  createApplicationDraftPreparationProvider,
  createApplicationDraftRecoveryReader,
  removeFixedApplicationDraftAsset,
  verifyApplicationDraftRecoveryBackup,
  readStagedDraftRecoveryBackup,
  removeExpiredApplicationDraftAssets,
  inspectHistoricalApplicationPublication,
  prepareApplicationReleaseDraft,
  publishPreparedApplicationRelease,
  readImmutableApplicationRelease,
  inspectApplicationReleaseAttestation,
  readBootstrapSiteArchive,
  decodeBootstrapDraftSiteAsset,
  inspectApplicationMetadataPublicationReceipt,
  inspectMetadataDraftPreparation,
  assertApplicationPublicationRecord,
  inspectApplicationWindowsCandidate,
  isApplicationWindowsJourneyRecord,
  selectApplicationWindowsPredecessor,
  readApplicationWindowsCandidateAssets,
  readApplicationWindowsPredecessorAssets,
} from "./application-release-publication.mts";
import type { ReleaseSourceAttestationExpectation } from "./release-source-attestation.mts";
import type { ApplicationDraftRecovery } from "./application-release-run.mts";
import type { ApplicationMetadataPublicationBinding } from "./application-release-publication.mts";
import {
  inspectApplicationRunCustody,
  inspectBootstrapDraftRecovery,
  readRegisteredApplicationRuns,
  immutableApplicationBootstrap,
  retainedServedRenewal,
  retainedServedRenewalFeed,
  failedBootstrapRecovery,
  retainedR56FeedRecovery,
  retainedV13FeedRecovery,
  retainedV8ServedRenewal,
  requireRetainedR56PreNativeEvidence,
  isEmptyApplicationBootstrapCustody,
  createApplicationRunRegistrationProvider,
  inspectApplicationReleaseReference,
  readActualApplicationBudgetOwner,
  assertApplicationCustodyMetadataExtension,
  readApplicationMetadataContextPlan,
  retainApplicationDraftAssembly,
  inspectApplicationQualificationIdentity,
  retainApplicationDraftRecovery,
  claimApplicationDraftAssetRemoval,
  retainApplicationMetadataContext,
} from "./application-release-run.mts";
import {
  prepareAuthenticatedMetadataRenewal,
  inspectPreparedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";

const execution = () => inspectApplicationReleaseExecution(process.env);
const sourceDirectory = path.resolve("work/application-source");
const toolDirectory = path.resolve("work/application-tools");
const onlineRoles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"] as const;
let receivedProtection: string | undefined;
let assertProtectionWriteWindow: () => void = () => {
  throw new Error("fresh protection receipt required before mutation");
};

function bootstrapAppointment() {
  return {
    descriptor_sha256: process.env.PORTCOVE_APPLICATION_BOOTSTRAP_DESCRIPTOR_SHA256 ?? "",
    setup_plan_sha256: process.env.PORTCOVE_APPLICATION_SETUP_PLAN_SHA256 ?? "",
    site_preimage_sha256: process.env.PORTCOVE_APPLICATION_INITIAL_SITE_PREIMAGE_SHA256 ?? "",
  };
}

export async function readNativeApplicationSource(directory = sourceDirectory) {
  const current = execution();
  const attempt = Number(process.env.PORTCOVE_SOURCE_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0 && attempt <= current.run_attempt);
  await receiveApplicationData(directory, {
    id: Number(process.env.PORTCOVE_SOURCE_ARTIFACT),
    name: `application-source-${current.run_id}-${attempt}`,
    run_id: current.run_id,
    source: current.source,
    files: ["source.json"],
    maximum_file_bytes: applicationSourcePacketMaximumBytes,
    maximum_archive_bytes: applicationSourcePacketMaximumBytes,
  });
  return loadNativeApplicationSource(directory);
}

/** Later commands in the same fixed job consume its already verified packet. */
async function loadNativeApplicationSource(directory = sourceDirectory) {
  const current = execution();
  const attempt = Number(process.env.PORTCOVE_SOURCE_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0 && attempt <= current.run_attempt);
  const source = await readApplicationJson(
    path.join(directory, "source.json"),
    applicationSourcePacketMaximumBytes,
  );
  assert.ok(isRecord(source) && source.schema_version === 1 && source.authority === "none");
  assert.equal(source.control_commit, current.source);
  assert.equal(source.control_ref, current.ref);
  assert.equal(source.run_id, current.run_id);
  assert.equal(source.producer_attempt, attempt);
  assert.equal(source.opportunity, process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY);
  assert.ok(
    ["application-release", "metadata-bootstrap", "metadata-renewal"].includes(
      String(source.purpose),
    ),
  );
  if (source.execution_path !== undefined) {
    if (source.purpose === "metadata-renewal") inspectApplicationRenewalSource(source);
    else if (source.purpose === "metadata-bootstrap")
      assert.equal(source.execution_path, "bootstrap-recovery");
    else {
      assert.equal(source.purpose, "application-release");
      assert.equal(source.execution_path, "immutable-recovery");
    }
  }
  if (source.purpose === "metadata-renewal") inspectApplicationRenewalSource(source);
  if (source.purpose === "application-release") {
    assert.ok(
      isRecord(source.prepared) &&
        isRecord(source.semantic) &&
        typeof source.original_source === "string" &&
        typeof source.original_tree === "string",
    );
    for (const field of [
      source.original_source,
      source.original_tree,
      source.prepared.prepared_commit,
      source.prepared.prepared_tree,
    ])
      assert.ok(typeof field === "string" && /^[a-f0-9]{40}$/u.test(field));
  }
  return source;
}

function applicationWorkerControlOptions(waitMs = 120000) {
  return {
    token: fixedReleaseReaderToken(),
    deadline: Math.min(coordinatorCommandDeadline() ?? Infinity, performance.now() + waitMs),
    guard: () => assertTrustedDirectNode("fixed application worker controls"),
    maxBytes: 8 * 1024 ** 2,
    requestTimeoutMs: 30000 as const,
  };
}

const metadataProtectionConsumers = {
  "metadata-releases": "releases",
  "metadata-preview": "preview",
  "metadata-stable": "stable",
  snapshot: "snapshot",
  timestamp: "timestamp",
} as const;

function metadataProtectionPhase(phase: string): phase is keyof typeof metadataProtectionConsumers {
  return Object.hasOwn(metadataProtectionConsumers, phase);
}

export function metadataProtectionConsumerReady(
  current: ReturnType<typeof execution>,
  phase: keyof typeof metadataProtectionConsumers,
  body: unknown,
  next: string | null,
) {
  const expected = `${metadataProtectionConsumers[phase]} / execute`;
  assert.ok(
    !next &&
      isRecord(body) &&
      Array.isArray(body.jobs) &&
      body.jobs.length < 100 &&
      body.total_count === body.jobs.length,
  );
  const seen = new Set<string>();
  let ready = false;
  for (const job of body.jobs) {
    assert.ok(isRecord(job) && typeof job.name === "string" && !seen.has(job.name));
    seen.add(job.name);
    assert.equal(job.run_id, Number(current.run_id));
    assert.equal(job.run_attempt, current.run_attempt);
    assert.equal(job.head_sha, current.source);
    if (job.name !== expected) continue;
    assert.notEqual(job.status, "completed", "metadata consumer settled before protection");
    assert.ok(Array.isArray(job.steps));
    if (
      job.steps.some(
        (step: unknown) =>
          isRecord(step) &&
          step.name === "Execute only the attested fixed role worker" &&
          step.status === "in_progress",
      )
    )
      ready = true;
  }
  return ready;
}

async function waitForMetadataProtectionConsumer(
  current: ReturnType<typeof execution>,
  phase: keyof typeof metadataProtectionConsumers,
) {
  const options = applicationWorkerControlOptions(190000);
  const provider = await createReleaseCustodyProvider({
    ...options,
    beforeDispatch: options.guard,
  });
  while (performance.now() < options.deadline) {
    const { body, next } = await provider.jobs(current.run_id, current.run_attempt, 1);
    if (metadataProtectionConsumerReady(current, phase, body, next)) return;
    await pause(2000);
  }
  throw new Error("metadata protection consumer wait exhausted");
}

async function waitForMetadataProtectionArtifact(
  current: ReturnType<typeof execution>,
  name: string,
  phase: keyof typeof metadataProtectionConsumers,
) {
  // Preview's protected observer can reach its worker after four minutes of
  // provider queue skew. Only artifact discovery gets this allowance.
  const options = applicationWorkerControlOptions(phase === "metadata-preview" ? 300000 : 190000);
  const provider = await createReleaseCustodyProvider({
    ...options,
    beforeDispatch: options.guard,
  });
  while (performance.now() < options.deadline) {
    const body = await provider.runArtifacts(current.run_id, 1);
    assert.ok(
      isRecord(body) &&
        Array.isArray(body.artifacts) &&
        body.artifacts.length < 100 &&
        body.total_count === body.artifacts.length,
    );
    const artifacts: unknown[] = body.artifacts;
    const matches = artifacts.filter(
      (row): row is Record<string, unknown> => isRecord(row) && row.name === name,
    );
    assert.ok(matches.length <= 1, "duplicate metadata protection artifact");
    if (matches.length === 1) {
      const { id } = matches[0]!;
      assert.ok(typeof id === "number" && Number.isSafeInteger(id) && id > 0);
      return id;
    }
    await pause(2000);
  }
  throw new Error("metadata protection artifact wait exhausted");
}

async function assertCurrentApplicationSemantic(original: string, semantic: unknown) {
  const producer = {
    schema_version: 2,
    purpose: "application",
    review_app_id: 5555053,
    review_check_name: semanticReviewCheckName,
  };
  const records = await readIndependentSemanticCheckInventoryWithSdk(
    applicationWorkerControlOptions(),
    producer,
    original,
  );
  const latest = selectLatestApplicationSemanticCheck(records.records);
  assert.ok(latest && isRecord(semantic));
  assert.equal(latest.id, semantic.check_id);
  assert.equal(latest.status, "completed");
  assert.equal(latest.conclusion, "success");
  assert.ok(isRecord(latest.output) && typeof latest.output.summary === "string");
  assert.equal(sha256(Buffer.from(latest.output.summary)), semantic.summary_sha256);
  await records.assertUnchanged();
}

async function guard(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  protection = true,
  options: {
    markStage?: (
      stage:
        | "pause-read"
        | "custody-read"
        | "budget-read"
        | "protection-receive"
        | "protection-policy"
        | "protection-digest",
    ) => void;
    useVerifiedSourceCustody?: boolean;
  } = {},
) {
  const { markStage, useVerifiedSourceCustody } = options;
  const current = execution();
  await verifyApplicationReleaseTrust();
  assert.equal(
    process.env.PORTCOVE_APPLICATION_RELEASE_ACTIVE,
    "true",
    "native production authority remains held",
  );
  assert.equal(
    sha256(await readFile(".github/workflows/application-release.yml")),
    process.env.PORTCOVE_APPLICATION_RELEASE_WORKFLOW_SHA256,
  );
  const spending = inspectApplicationSpendingAppointment(
    process.env,
    applicationReleaseMaximumMinutes(source.purpose, source.execution_path ?? "ordinary"),
  );
  markStage?.("pause-read");
  const pause = await readPublicationPauseWithSdk(applicationWorkerControlOptions());
  assert.equal(pause.publication_paused, false, "publication paused");
  if (source.purpose === "application-release") {
    assert.ok(typeof source.original_source === "string");
    await assertCurrentApplicationSemantic(source.original_source, source.semantic);
  }
  if (source.purpose === "metadata-bootstrap")
    inspectApplicationBootstrapSource(source, bootstrapAppointment());
  if (source.purpose === "metadata-renewal") inspectApplicationRenewalSource(source);
  if (protection) {
    const attempt = Number(process.env.PORTCOVE_PROTECTION_ATTEMPT);
    assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
    const phase = process.env.PORTCOVE_PROTECTION_PHASE ?? "";
    assert.ok(
      [
        "payload",
        "metadata",
        "metadata-releases",
        "metadata-preview",
        "metadata-stable",
        "snapshot",
        "timestamp",
        "draft-recovery",
        "publication",
        "feed",
      ].includes(phase),
    );
    if (phase.startsWith("metadata-")) {
      assert.ok(
        metadataProtectionPhase(phase) &&
          source.purpose === "metadata-renewal" &&
          source.execution_path === "metadata-maintenance" &&
          process.argv[2] === `role-${metadataProtectionConsumers[phase]}`,
      );
    }
    const directory = path.resolve("work/application-protection");
    const name = `application-protection-${phase}-${current.run_id}-${attempt}`;
    const artifact = process.env.PORTCOVE_PROTECTION_ARTIFACT;
    const identity = JSON.stringify([artifact, phase, current.source, current.run_id, attempt]);
    if (receivedProtection !== undefined) assert.equal(receivedProtection, identity);
    else {
      const waitsForObservation =
        !artifact &&
        source.purpose === "metadata-renewal" &&
        source.execution_path === "metadata-maintenance" &&
        metadataProtectionPhase(phase) &&
        process.argv[2] === `role-${metadataProtectionConsumers[phase]}`;
      if (waitsForObservation) {
        assert.equal(attempt, current.run_attempt);
        markStage?.("protection-receive");
      }
      await receiveApplicationData(directory, {
        id: waitsForObservation
          ? await waitForMetadataProtectionArtifact(current, name, phase)
          : Number(artifact),
        name,
        source: current.source,
        run_id: current.run_id,
        files: ["protection.json"],
        maximum_file_bytes: 2 * 1024 ** 2,
        maximum_archive_bytes: 2 * 1024 ** 2,
      });
      receivedProtection = identity;
    }
    // Reuse only the authenticated provider input, never its freshness result.
    // Each guard checks the original observation time against the appointed handoff.
    const receipt = await readApplicationJson(
      path.join(directory, "protection.json"),
      2 * 1024 ** 2,
    );
    assert.ok(
      isRecord(receipt) &&
        receipt.phase === phase &&
        receipt.source === current.source &&
        receipt.run_id === current.run_id &&
        receipt.attempt === attempt,
    );
    const expectedDigest = process.env.PORTCOVE_APPLICATION_RELEASE_PROTECTION_SHA256;
    const observation = isRecord(receipt.observation) ? receipt.observation : undefined;
    publicationProtectionObservedAt =
      typeof observation?.observed_at === "string" ? observation.observed_at : undefined;
    const recoveryFeedHandoff =
      phase === "feed" &&
      [retainedR56FeedRecovery.next_ref, retainedV13FeedRecovery.next_ref].some(
        (ref) => current.ref === ref,
      ) &&
      source.purpose === "metadata-renewal" &&
      source.execution_path === "metadata-recovery";
    const preparingApplication =
      source.purpose === "application-release" && source.execution_path === undefined;
    assertProtectionWriteWindow = () => {
      markStage?.("protection-policy");
      const actualDigest = requireApplicationReleaseProtectionDigest(
        receipt.observation,
        source.purpose === "metadata-bootstrap",
        Date.now(),
        preparingApplication && phase === "payload"
          ? "application-payload"
          : preparingApplication || recoveryFeedHandoff
            ? "hosted-write"
            : "standard",
      );
      markStage?.("protection-digest");
      assert.equal(actualDigest, expectedDigest);
    };
    assertProtectionWriteWindow();
  }
  assert.ok(isRecord(source.run_custody));
  const expected = inspectApplicationRunCustody(source.run_custody.custody);
  assert.equal(expected.opportunity, source.opportunity);
  if (source.purpose === "application-release") {
    assert.equal(expected.source, source.original_source);
    assert.equal(expected.source_tree, source.original_tree);
    assert.ok(expected.preparation);
    assert.deepEqual(expected.preparation.classification, source.classification);
    assert.ok(isRecord(source.prepared));
    for (const key of ["version", "prepared_commit", "prepared_tree", "intent_sha256"] as const)
      assert.equal(expected.preparation[key], source.prepared[key]);
  }
  markStage?.("custody-read");
  const releaseId = Number(source.run_custody.release_id);
  assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
  if (source.execution_path === "bootstrap-recovery") {
    assert.equal(source.purpose, "metadata-bootstrap");
    assert.equal(releaseId, immutableApplicationBootstrap.release_id);
    assert.ok(isEmptyApplicationBootstrapCustody(expected));
  }
  // Read-only fixed jobs consume the source producer's positively read-back
  // draft registration. Context and publication writes re-read the live draft.
  if (useVerifiedSourceCustody)
    assert.deepEqual(expected.runs.at(-1), {
      id: current.run_id,
      control_commit: current.source,
      control_ref: current.ref,
    });
  const registered = useVerifiedSourceCustody
    ? expected
    : await readRegisteredApplicationRuns(
        await createApplicationRunRegistrationProvider(),
        releaseId,
        expected.opportunity,
        expected.source,
        expected.source_tree,
        current,
      );
  assertApplicationCustodyMetadataExtension(expected, registered);
  if (source.renewal_parent !== undefined) {
    inspectApplicationReleaseReference(source.renewal_parent);
    assert.equal(
      registered.budget?.kind,
      "member",
      "forward renewal must retain its original cost owner",
    );
    const owner = await readActualApplicationBudgetOwner({
      release_id: Number(source.run_custody.release_id),
      custody: registered,
    });
    if (owner.custody.preparation)
      await assertCurrentApplicationSemantic(owner.custody.source, source.renewal_semantic);
  }
  const known = registered.runs.map((run) => run.id);
  assert.deepEqual(JSON.parse(process.env.PORTCOVE_KNOWN_RELEASE_RUNS ?? "null"), known);
  markStage?.("budget-read");
  const budget = await readApplicationJobBudget(
    known,
    source.purpose,
    source.execution_path ?? "ordinary",
    { release_id: Number(source.run_custody.release_id), custody: registered },
  );
  if (protection) assertProtectionWriteWindow();
  return { spending, pause, budget };
}

function publicationBinding(
  source: Record<string, unknown>,
  attempt: number,
): ApplicationMetadataPublicationBinding {
  const current = execution();
  if (source.purpose === "metadata-renewal") {
    const basis = inspectApplicationRenewalSource(source);
    assert.ok(
      typeof basis.site_generation === "string" && typeof basis.repository_sha256 === "string",
    );
    return {
      purpose: "metadata-renewal",
      control_commit: current.source,
      control_ref: current.ref,
      opportunity: String(source.opportunity),
      run_id: current.run_id,
      producer_attempt: attempt,
      prior_generation: basis.site_generation,
      prior_repository_sha256:
        source.renewal_parent === undefined
          ? basis.repository_sha256
          : String(source.renewal_public_prior_repository_sha256),
      ...(source.renewal_parent === undefined
        ? {}
        : {
            authority_repository_sha256: basis.repository_sha256,
            renewal_parent: inspectApplicationReleaseReference(source.renewal_parent),
          }),
    };
  }
  assert.equal(source.purpose, "metadata-bootstrap");
  assert.ok(
    isRecord(source.bootstrap_preimage) &&
      typeof source.bootstrap_preimage.inventory_sha256 === "string",
  );
  return {
    control_commit: current.source,
    control_ref: current.ref,
    opportunity: String(source.opportunity),
    run_id: current.run_id,
    producer_attempt: attempt,
    appointment: bootstrapAppointment(),
    retained_inventory_sha256: source.bootstrap_preimage.inventory_sha256,
  };
}

function bootstrapDraftRecovery(source: Record<string, unknown>) {
  if (source.bootstrap_draft_recovery === undefined) {
    assert.equal(source.bootstrap_draft_site_base64, undefined);
    return undefined;
  }
  assert.equal(source.purpose, "metadata-bootstrap");
  const recovery = inspectBootstrapDraftRecovery(source.bootstrap_draft_recovery);
  assert.ok(recovery.site_archive && isRecord(source.run_custody));
  assert.equal(recovery.release_id, source.run_custody.release_id);
  assert.equal(typeof source.bootstrap_draft_site_base64, "string");
  return { ...recovery, site_archive: recovery.site_archive };
}

async function stageBootstrapSite() {
  // This is the same key-free assembly job, after standard artifact upload.
  const source = await readApplicationJson(path.join(sourceDirectory, "source.json"));
  assert.ok(isRecord(source));
  await guard(source, false, { useVerifiedSourceCustody: true });
  const current = execution();
  const assembly = await readApplicationJson("work/application-assembly/assembly.json");
  const site = await readApplicationJson("work/application-assembly/site.json");
  assert.ok(
    isRecord(assembly) &&
      isRecord(site) &&
      isRecord(site.generation) &&
      Array.isArray(site.generation.files),
  );
  const names = site.generation.files.map((file: unknown) => {
    assert.ok(isRecord(file) && typeof file.path === "string");
    return file.path;
  });
  const destination = path.resolve("work/application-publication-assets");
  const recovery = bootstrapDraftRecovery(source);
  let archive: { bytes: number; sha256: string };
  if (recovery) {
    const asset = recovery.site_archive;
    archive = { bytes: asset.bytes, sha256: asset.sha256 };
  } else
    archive = await receiveApplicationData(path.resolve("work/application-site-verified"), {
      id: Number(process.env.PORTCOVE_SITE_ARTIFACT),
      name: `application-site-${current.run_id}-${current.run_attempt}`,
      source: current.source,
      run_id: current.run_id,
      files: [...names, "publication.json"],
      maximum_file_bytes: 64 * 1024 ** 2,
      retain_archive: path.join(destination, bootstrapAssetNames[0]),
    });
  const common = {
    schema_version: 1,
    authority: "none",
    control_commit: current.source,
    control_ref: current.ref,
    opportunity: source.opportunity,
    run_id: current.run_id,
    producer_attempt: current.run_attempt,
    publication: assembly.publication,
    site_generation: site.generation,
    retained_inventory_sha256: site.retained_inventory_sha256,
    site_archive: {
      filename: bootstrapAssetNames[0],
      bytes: archive.bytes,
      sha256: archive.sha256,
    },
  };
  assert.ok(
    ["metadata-bootstrap", "metadata-renewal", "application-release"].includes(
      String(source.purpose),
    ),
  );
  const receipt =
    source.purpose === "metadata-bootstrap"
      ? {
          ...common,
          kind: "application-bootstrap-publication",
          bootstrap_descriptor: source.bootstrap_descriptor,
        }
      : {
          ...common,
          kind: "application-metadata-publication",
          purpose: source.purpose,
          prior_generation: site.prior_generation,
          prior_repository_sha256: site.prior_repository_sha256,
          context_sha256: site.context_sha256,
          ...(source.renewal_parent === undefined
            ? {}
            : {
                schema_version: 2,
                authority_repository_sha256: site.authority_repository_sha256,
                renewal_parent: inspectApplicationReleaseReference(source.renewal_parent),
              }),
        };
  assert.ok(isRecord(source.run_custody));
  const inspected =
    source.purpose !== "application-release"
      ? inspectApplicationMetadataPublicationReceipt(
          receipt,
          publicationBinding(source, current.run_attempt),
          inspectApplicationRunCustody(source.run_custody.custody),
        )
      : inspectHistoricalApplicationPublication(
          receipt,
          inspectApplicationRunCustody(source.run_custody.custody),
        );
  const archiveBytes = recovery
    ? decodeBootstrapDraftSiteAsset(recovery, source.bootstrap_draft_site_base64)
    : await readFile(path.join(destination, bootstrapAssetNames[0]));
  inspectBootstrapSiteArchive(archiveBytes, inspected);
  if (recovery) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await writeFile(path.join(destination, bootstrapAssetNames[0]), archiveBytes, {
      flag: "wx",
      mode: 0o600,
    });
  }
  const metadataPath = path.join(destination, bootstrapAssetNames[1]);
  await writeApplicationJson(metadataPath, receipt);
  if (source.purpose !== "metadata-bootstrap") {
    const releaseId = Number(source.run_custody.release_id);
    assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
    const draft = applicationDraftAssembly(
      releaseId,
      receipt,
      inspected.publication,
      new Map([
        [bootstrapAssetNames[0], archiveBytes],
        [bootstrapAssetNames[1], await readFile(metadataPath)],
      ]),
    );
    const proofDir = path.resolve("work/application-draft-assembly-proof");
    await mkdir(proofDir, { recursive: true });
    await writeFile(
      path.join(proofDir, applicationDraftProofName),
      applicationDraftProofBytes(draft),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }
}

async function receiveApplicationAssembly(
  directory = path.resolve("work/application-publication-input"),
  retainedDraft = false,
) {
  const current = execution();
  const retained = retainedDraft ? retainedServedRenewalFeed : undefined;
  const actor = retained?.assembly;
  const source = actor?.control_commit ?? current.source;
  const ref = actor?.control_ref ?? current.ref;
  const run = actor?.id ?? current.run_id;
  const attempt = actor?.attempt ?? Number(process.env.PORTCOVE_PUBLICATION_INPUT_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const archive = await receiveApplicationData(directory, {
    id: retained?.assembly_artifact ?? Number(process.env.PORTCOVE_PUBLICATION_INPUT_ARTIFACT),
    name: `application-publication-input-${run}-${attempt}`,
    source,
    run_id: run,
    files: bootstrapAssetNames,
  });
  if (retained) assert.equal(archive.sha256, retained.assembly_artifact_sha256);
  const subjects = await Promise.all(
    bootstrapAssetNames.map(async (name) => {
      const file = await applicationFileIdentity(path.join(directory, name));
      if (retained) {
        assert.equal(file.bytes, retained.assets[name].bytes);
        assert.equal(file.sha256, retained.assets[name].sha256);
      }
      return { filename: name, sha256: file.sha256 };
    }),
  );
  await verifyReleaseSourceAttestation(
    directory,
    bootstrapAssetNames[1],
    {
      source_commit: source,
      ref,
      run_id: run,
      run_attempt: attempt,
      subjects,
    },
    { scope: "application-assembly" },
  );
  return { directory, attempt };
}

function ordinaryPublicationExpected(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  attempt: number,
) {
  const current = execution();
  assert.equal(source.purpose, "application-release");
  assert.ok(isRecord(source.run_custody));
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  return {
    release_id: Number(source.run_custody.release_id),
    custody: inspectApplicationRunCustody(source.run_custody.custody),
    producer: {
      control_commit: current.source,
      control_ref: current.ref,
      run_id: current.run_id,
      attempt,
    },
  };
}

async function authenticateDraftRecoveryAssembly(
  filename: string,
  bytes: Buffer,
  binding: ReleaseSourceAttestationExpectation,
) {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP!, "application-draft-proof-"));
  await writeFile(path.join(scratch, filename), bytes, { flag: "wx", mode: 0o600 });
  await verifyReleaseSourceAttestation(scratch, filename, binding, {
    scope: "application-assembly",
  });
}

async function receiveDraftRecoveryBackup(expected: Parameters<typeof receiveApplicationData>[1]) {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP!, "application-draft-backup-"));
  const destination = path.join(scratch, "readback");
  const identity = await receiveApplicationData(destination, expected);
  const files = new Map(
    await Promise.all(
      expected.files.map(
        async (name) => [name, await readFile(path.join(destination, name))] as const,
      ),
    ),
  );
  return { ...identity, files };
}

function applicationDraftRecoveryObservation(
  expected: Parameters<typeof readApplicationDraftRecoveryState>[1],
) {
  const token = fixedReleaseReaderToken();
  return () =>
    readApplicationDraftRecoveryState(
      (deadline) => createApplicationDraftRecoveryReader(token, expected, deadline),
      expected,
    );
}

async function prepareDraftRecovery(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  assemblyDirectory: string,
) {
  const current = execution();
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  assert.ok(source.purpose === "application-release" || source.purpose === "metadata-renewal");
  assert.ok(isRecord(source.run_custody));
  await guard(source, false);
  const expected = {
    release_id: Number(source.run_custody.release_id),
    custody: inspectApplicationRunCustody(source.run_custody.custody),
    producer: {
      control_commit: current.source,
      control_ref: current.ref,
      run_id: current.run_id,
      attempt: current.run_attempt,
    },
  };
  const inspect = applicationDraftRecoveryObservation(expected);
  const initial = await inspect();
  if (
    !initial ||
    !initial.assets.some((asset) => bootstrapAssetNames.some((name) => name === asset.name))
  )
    return;
  const { directory, attempt } = await receiveApplicationAssembly(assemblyDirectory);
  const files = new Map(
    await Promise.all(
      bootstrapAssetNames.map(
        async (name) => [name, await readFile(path.join(directory, name))] as const,
      ),
    ),
  );
  const metadata = files.get(bootstrapAssetNames[1])!;
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
  assert.ok(isRecord(raw));
  assert.equal(raw.control_commit, current.source);
  assert.equal(raw.control_ref, current.ref);
  assert.equal(raw.run_id, current.run_id);
  assert.equal(raw.producer_attempt, attempt);
  assert.equal(raw.purpose, source.purpose);
  const receipt =
    source.purpose === "application-release"
      ? inspectHistoricalApplicationPublication(raw, expected.custody)
      : inspectApplicationMetadataPublicationReceipt(
          raw,
          publicationBinding(source, attempt),
          expected.custody,
        );
  inspectBootstrapSiteArchive(files.get(bootstrapAssetNames[0])!, receipt);
  const replacement = applicationDraftAssembly(
    expected.release_id,
    raw,
    receipt.publication,
    files,
  );
  const staged = initial.assets.filter((asset) =>
    bootstrapAssetNames.some((name) => name === asset.name),
  );
  if (
    staged.every((asset) =>
      replacement.subjects.some(
        (subject) =>
          subject.name === asset.name &&
          subject.bytes === asset.bytes &&
          subject.sha256 === asset.sha256,
      ),
    )
  )
    return;
  const before = async () => {
    await guard(source, false);
    assert.deepEqual(await inspect(), initial, "draft changed before retaining replacement");
  };
  const owner = await retainApplicationDraftAssembly(
    await createApplicationRunRegistrationProvider(),
    expected,
    current,
    replacement,
    before,
  );
  const retained = await inspect();
  assert.ok(retained);
  assert.deepEqual(retained, {
    ...initial,
    notes: owner.release_id === expected.release_id ? owner.notes : initial.notes,
  });
  const existing = owner.custody.draft_recoveries?.find(
    (entry) => entry.replacement_context_sha256 === replacement.context_sha256,
  );
  if (existing) {
    await verifyRetainedDraftRecovery(expected, owner, replacement, metadata, retained, existing);
    await guard(source, false);
    assert.deepEqual(await inspect(), retained, "draft changed during backup reuse");
    await applicationOutput("recovery_needed", true);
    return;
  }
  const verified = await readExpiredApplicationDraftAssets(
    expected,
    owner,
    replacement,
    metadata,
    retained.assets,
    {
      readAsset: createFixedApplicationReleaseAssetReader(),
      authenticateAssembly: authenticateDraftRecoveryAssembly,
    },
  );
  assert.deepEqual(await inspect(), retained, "draft changed during backup preparation");
  return { owner: { release_id: owner.release_id, custody: owner.custody }, retained, verified };
}

async function stageDraftRecovery() {
  const source = await readNativeApplicationSource();
  const prepared = await prepareDraftRecovery(
    source,
    path.resolve("work/application-recovery-stage-assembly"),
  );
  if (!prepared) return;
  const backup = path.resolve("work/application-draft-recovery-backup");
  await mkdir(backup);
  for (const { asset, bytes } of prepared.verified.backup)
    await writeFile(path.join(backup, asset.name), bytes, { flag: "wx", mode: 0o600 });
  await applicationOutput("draft_sha256", releaseCanonicalDigest(prepared.retained));
  await applicationOutput("owner_sha256", releaseCanonicalDigest(prepared.owner));
  await applicationOutput("old_context_sha256", prepared.verified.preimage.old_context_sha256);
  await applicationOutput(
    "replacement_context_sha256",
    prepared.verified.preimage.replacement_context_sha256,
  );
  await applicationOutput("backup_directory", backup);
  await applicationOutput("recovery_needed", true);
}

async function retainDraftRecoveryBackup() {
  const source = await readNativeApplicationSource(
    path.resolve("work/application-recovery-source"),
  );
  const current = execution();
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  assert.ok(source.purpose === "application-release" || source.purpose === "metadata-renewal");
  assert.ok(isRecord(source.run_custody));
  await guard(source, false);
  const expected = {
    release_id: Number(source.run_custody.release_id),
    custody: inspectApplicationRunCustody(source.run_custody.custody),
    producer: {
      control_commit: current.source,
      control_ref: current.ref,
      run_id: current.run_id,
      attempt: current.run_attempt,
    },
  };
  const inspect = applicationDraftRecoveryObservation(expected);
  const draft = await inspect();
  assert.ok(draft);
  assert.equal(releaseCanonicalDigest(draft), process.env.PORTCOVE_DRAFT_BACKUP_DRAFT_SHA256);
  const { owner } = await readApplicationMetadataContextPlan(
    await createApplicationRunRegistrationProvider(),
    expected,
    current,
  );
  assert.equal(releaseCanonicalDigest(owner), process.env.PORTCOVE_DRAFT_BACKUP_OWNER_SHA256);
  const staged = readStagedDraftRecoveryBackup(
    draft,
    owner.custody,
    process.env.PORTCOVE_DRAFT_BACKUP_OLD_CONTEXT_SHA256 ?? "",
    process.env.PORTCOVE_DRAFT_BACKUP_REPLACEMENT_CONTEXT_SHA256 ?? "",
  );
  const recovery = await verifyApplicationDraftRecoveryBackup(
    staged,
    Number(process.env.PORTCOVE_DRAFT_BACKUP_ARTIFACT),
    current,
    receiveDraftRecoveryBackup,
  );
  await retainApplicationDraftRecovery(
    await createApplicationRunRegistrationProvider(),
    expected,
    current,
    recovery,
    async () => {
      await guard(source, false);
      assert.deepEqual(
        (
          await readApplicationMetadataContextPlan(
            await createApplicationRunRegistrationProvider(),
            expected,
            current,
          )
        ).owner,
        owner,
        "recovery owner changed during backup readback",
      );
      assert.deepEqual(await inspect(), draft, "draft changed during backup readback");
    },
  );
}

async function verifyRetainedDraftRecovery(
  expected: Parameters<typeof readApplicationDraftRecoveryState>[1],
  owner: Awaited<ReturnType<typeof readApplicationMetadataContextPlan>>["owner"],
  replacement: ReturnType<typeof applicationDraftAssembly>,
  metadata: Buffer,
  initial: NonNullable<Awaited<ReturnType<typeof readApplicationDraftRecoveryState>>>,
  recovery: ApplicationDraftRecovery,
) {
  const current = execution();
  assert.ok(recovery.backup.run_attempt <= current.run_attempt);
  const old = owner.custody.draft_assemblies?.find(
    (entry) => entry.context_sha256 === recovery.old_context_sha256,
  );
  assert.ok(old);
  const archive = await receiveDraftRecoveryBackup({
    id: recovery.backup.id,
    name: `application-draft-recovery-${current.run_id}-${recovery.backup.run_attempt}`,
    run_id: current.run_id,
    source: current.source,
    files: recovery.assets.map((asset) => asset.name),
  });
  const original = recovery.assets.map((asset) => {
    const subject = old.subjects.find((subject) => subject.name === asset.name);
    assert.ok(subject);
    return { ...subject, id: asset.id };
  });
  const retained = initial.assets.filter(
    (asset) => !bootstrapAssetNames.some((name) => name === asset.name),
  );
  const verified = await readExpiredApplicationDraftAssets(
    expected,
    owner,
    replacement,
    metadata,
    [...retained, ...original],
    {
      async readAsset(id) {
        const asset = original.find((entry) => entry.id === id);
        assert.ok(asset);
        const bytes = archive.files.get(asset.name);
        assert.ok(bytes);
        return bytes;
      },
      authenticateAssembly: authenticateDraftRecoveryAssembly,
    },
  );
  const checked = await verifyApplicationDraftRecoveryBackup(
    verified,
    recovery.backup.id,
    { ...current, run_attempt: recovery.backup.run_attempt },
    async () => archive,
  );
  assert.deepEqual(checked, recovery);
  return old;
}

async function finishDraftRecovery(
  expected: Parameters<typeof readApplicationDraftRecoveryState>[1],
  raw: Record<string, unknown>,
  publication: Parameters<typeof applicationDraftAssembly>[2],
  files: ReadonlyMap<string, Buffer>,
  beforeWrite: () => Promise<() => void | Promise<void>>,
) {
  const current = execution();
  const inspect = applicationDraftRecoveryObservation(expected);
  const initial = await inspect();
  if (!initial) return;
  const replacement = applicationDraftAssembly(expected.release_id, raw, publication, files);
  const { owner } = await readApplicationMetadataContextPlan(
    await createApplicationRunRegistrationProvider(),
    expected,
    current,
  );
  const recovery = owner.custody.draft_recoveries?.find(
    (entry) => entry.replacement_context_sha256 === replacement.context_sha256,
  );
  if (!recovery) return;
  const retained = initial.assets.filter(
    (asset) => !bootstrapAssetNames.some((name) => name === asset.name),
  );
  assert.equal(
    releaseCanonicalDigest(retained.sort((left, right) => left.id - right.id)),
    recovery.retained_assets_sha256,
    "retained draft assets changed after backup",
  );
  if (!initial.assets.some((asset) => recovery.assets.some((old) => old.id === asset.id))) return;
  const old = await verifyRetainedDraftRecovery(
    expected,
    owner,
    replacement,
    files.get(bootstrapAssetNames[1])!,
    initial,
    recovery,
  );
  assert.deepEqual(await inspect(), initial, "draft changed while authenticating recovery backup");
  const token = fixedReleaseReaderToken();
  await removeExpiredApplicationDraftAssets(recovery, old, replacement, {
    removeAsset: (id, assertFresh) =>
      removeFixedApplicationDraftAsset(token, id, () => {
        assertProtectionWriteWindow();
        assertFresh();
      }),
    async inspectDraft() {
      const draft = await inspect();
      assert.ok(draft && draft.direct === initial.direct);
      return draft;
    },
    async claim(assetId, beforeClaim) {
      return claimApplicationDraftAssetRemoval(
        await createApplicationRunRegistrationProvider(),
        expected,
        current,
        recovery,
        assetId,
        beforeClaim,
      );
    },
    beforeWrite,
  });
}

async function prepareOrdinaryPublication(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
) {
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  const current = execution();
  await guard(source, false);
  const expected = ordinaryPublicationExpected(source, current.run_attempt);
  const assembly = await receiveApplicationAssembly();
  const metadata = await readApplicationJson(
    path.join(assembly.directory, bootstrapAssetNames[1]),
    2 * 1024 ** 2,
  );
  assert.ok(isRecord(metadata));
  assert.equal(metadata.run_id, current.run_id);
  assert.equal(metadata.control_commit, current.source);
  assert.equal(metadata.control_ref, current.ref);
  assert.equal(metadata.producer_attempt, assembly.attempt);
  const receivedContext = await receiveApplicationContext();
  const context = receivedContext.directory;
  await assertReservedApplicationContext(source, receivedContext, "live");
  assert.equal(metadata.context_sha256, sha256(await readFile(path.join(context, "context.json"))));
  const scratch = path.join(process.env.RUNNER_TEMP ?? "", "application-draft-preparation");
  assert.ok(path.isAbsolute(scratch));
  await mkdir(scratch);
  const inspected = inspectApplicationContextBeforeKey(
    context,
    path.join(toolDirectory, "portcove-release-tools"),
    scratch,
  );
  assert.ok(
    typeof inspected.records === "number" &&
      inspected.records > 0 &&
      inspected.records_unchanged === false,
  );
  const packages = await receiveNativePackages(source);
  const native = await readNativePayloadAcceptance(source, packages);
  const signedPayload = await receiveApplicationSignedPayload(source, packages, scratch);
  const contextFiles = await readBoundedReleaseContextFiles(context);
  await assertApplicationContextCurrentRecords(
    contextFiles,
    applicationRecordInput(source, packages, native, signedPayload),
  );
  const { discovered, prior } = await readApplicationPriorPublication(scratch);
  assert.equal(metadata.prior_generation, prior.receipt.site.generation);
  assert.equal(metadata.prior_repository_sha256, prior.receipt.publication.repository_sha256);
  assert.equal(
    applicationContextPriorRepositorySha256(contextFiles),
    prior.receipt.publication.repository_sha256,
  );
  await readPublicApplicationSiteMarker(prior.receipt.site);
  assert.deepEqual(
    await readActualApplicationPagesState(),
    discovered.state,
    "prior Pages actor changed before draft preparation",
  );
  const files = new Map<string, Buffer>();
  for (const file of packages.manifest.files)
    files.set(
      file.filename,
      await readFile(path.resolve("work/application-unsigned", file.filename)),
    );
  files.set(
    "application-release.json",
    await readFile(path.resolve("work/application-unsigned/application-release.json")),
  );
  files.set(signedPayload.filename, signedPayload.signature);
  files.set("updater-inventory.json", signedPayload.inventory);
  for (const name of bootstrapAssetNames)
    files.set(name, await readFile(path.join(assembly.directory, name)));
  const receipt = inspectHistoricalApplicationPublication(metadata, expected.custody);
  await finishDraftRecovery(expected, metadata, receipt.publication, files, async () => {
    await readPublicApplicationSiteMarker(prior.receipt.site);
    assert.deepEqual(await discoverActualPublishedApplicationCohort(), discovered);
    await guard(source);
    return async () => {
      assert.deepEqual(await readActualApplicationPagesState(), discovered.state);
      assertProtectionWriteWindow();
    };
  });
  const result = await prepareApplicationReleaseDraft(expected, files, {
    open: (deadline) =>
      createApplicationDraftPreparationProvider(fixedReleaseReaderToken(), expected, deadline),
    upload: await createApplicationAssetUploader(process.env.GH_TOKEN),
    async retainAssembly(assembly) {
      return retainApplicationDraftAssembly(
        await createApplicationRunRegistrationProvider(),
        expected,
        current,
        assembly,
        async () => {
          await guard(source, false);
        },
      );
    },
    readAsset: createFixedApplicationReleaseAssetReader(),
    async beforeDraftWrite() {
      await guard(source, false);
    },
  });
  assert.deepEqual(
    await discoverActualPublishedApplicationCohort(),
    discovered,
    "public prior changed during draft preparation",
  );
  await writeApplicationJson("work/application-draft-prepared/prepared.json", result);
  await writeApplicationJson("work/application-draft-prepared/prior-site.json", {
    schema_version: 1,
    authority: "none",
    site: prior.receipt.site,
    provider: discovered.state,
  });
  await applicationOutput("attempt", current.run_attempt);
}

async function receiveApplicationDraftPreparation(bootstrap: boolean) {
  const current = execution();
  const attempt = Number(process.env.PORTCOVE_DRAFT_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const directory = path.resolve("work/application-draft-received");
  const names = ["prepared.json", "prior-site.json", ...(bootstrap ? bootstrapAssetNames : [])];
  await receiveApplicationData(directory, {
    id: Number(process.env.PORTCOVE_DRAFT_ARTIFACT),
    name: `application-draft-${current.run_id}-${attempt}`,
    run_id: current.run_id,
    source: current.source,
    files: names,
    ...(bootstrap ? {} : { maximum_file_bytes: 128 * 1024, maximum_archive_bytes: 512 * 1024 }),
  });
  const attestation = {
    source_commit: current.source,
    ref: current.ref,
    run_id: current.run_id,
    run_attempt: attempt,
    subjects: await Promise.all(
      names.map(async (filename) => ({
        filename,
        sha256: sha256(await readFile(path.join(directory, filename))),
      })),
    ),
  };
  return {
    directory,
    attempt,
    attestation,
    authenticatePreparation: async () => {
      await verifyReleaseSourceAttestation(directory, "prepared.json", attestation, {
        scope: "application-controller",
      });
    },
  };
}

async function publishOrdinaryMetadata(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
) {
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  const current = execution();
  await guard(source, false);
  const received = await receiveApplicationDraftPreparation(false);
  const { directory, attempt } = received;
  const expected = ordinaryPublicationExpected(source, attempt);
  const preparation = await readFile(path.join(directory, "prepared.json"));
  const result = await publishPreparedApplicationRelease(expected, preparation, {
    open: (deadline) =>
      createPreparedApplicationPublicationProvider(
        fixedReleaseReaderToken(),
        expected,
        () => assertProtectionWriteWindow(),
        deadline,
      ),
    authenticatePreparation: received.authenticatePreparation,
    async beforeWrite() {
      const prepared = await readApplicationJson(path.join(directory, "prepared.json"), 128 * 1024);
      const prior = await readApplicationJson(path.join(directory, "prior-site.json"), 128 * 1024);
      assert.ok(
        isRecord(prepared) &&
          isRecord(prior) &&
          prior.schema_version === 1 &&
          prior.authority === "none" &&
          isRecord(prior.site) &&
          isRecord(prior.provider),
      );
      assert.equal(prior.site.generation, prepared.prior_generation);
      const discovered = await discoverActualPublishedApplicationCohort();
      assert.deepEqual(
        discovered.state,
        prior.provider,
        "prior Pages actor changed before publication",
      );
      await readPublicApplicationSiteMarker(prior.site);
      assert.deepEqual(
        await readActualApplicationPagesState(),
        prior.provider,
        "prior Pages actor changed during final marker bracket",
      );
      await guard(source);
      return assertProtectionWriteWindow;
    },
  });
  await writeApplicationJson("work/application-publication/result.json", result);
  await applicationOutput("release_id", result.release_id);
  await applicationOutput("site_generation", String(result.site_generation));
  await applicationOutput("attempt", current.run_attempt);
}

async function receiveMetadataDraftPreparation(purpose: "metadata-bootstrap" | "metadata-renewal") {
  const { directory, attestation, authenticatePreparation } =
    await receiveApplicationDraftPreparation(true);
  await authenticatePreparation();
  const prepared = inspectMetadataDraftPreparation(
    await readApplicationJson(path.join(directory, "prepared.json"), 128 * 1024),
    attestation,
    purpose,
  );
  return { directory, prepared, attempt: prepared.assembly_attempt };
}

async function publishMetadataRelease(
  stage: "prepare" | "publish",
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
) {
  publicationStage = "source";
  publicationProtectionObservedAt = undefined;
  const guardSource = (protection = true) =>
    guard(source, protection, {
      markStage(next) {
        publicationStage = next;
      },
    });
  assert.ok(source.purpose === "metadata-bootstrap" || source.purpose === "metadata-renewal");
  const retainedDraft = source.execution_path === "metadata-draft-recovery";
  if (source.purpose === "metadata-renewal")
    assert.ok(source.execution_path === "metadata-maintenance" || retainedDraft);
  if (retainedDraft) {
    assert.equal(source.purpose, "metadata-renewal");
    assert.equal(execution().ref, retainedServedRenewalFeed.next_ref);
    assert.equal(source.opportunity, retainedServedRenewal.opportunity);
    assert.equal(source.renewal_parent, undefined);
  }
  // The split publisher only reads until its final full guard. Repeating the
  // custody and budget inventory before those reads spends the fresh window.
  if (stage !== "publish") await guardSource(false);
  const current = execution();
  publicationStage = stage === "publish" ? "prepared-input" : "assembly-input";
  const preparedInput =
    stage === "publish" ? await receiveMetadataDraftPreparation(source.purpose) : undefined;
  const input = preparedInput ?? (await receiveApplicationAssembly(undefined, retainedDraft));
  const { directory, attempt } = input;
  assert.ok(isRecord(source.run_custody));
  const token = process.env.GH_TOKEN;
  assert.ok(token && token.length <= 16384 && !/[\r\n\0]/u.test(token));
  const recovery = bootstrapDraftRecovery(source);
  const binding = publicationBinding(source, attempt);
  const actor = retainedServedRenewalFeed.assembly;
  const expected = {
    release_id: Number(source.run_custody.release_id),
    custody: inspectApplicationRunCustody(source.run_custody.custody),
    binding: retainedDraft
      ? {
          ...binding,
          control_commit: actor.control_commit,
          control_ref: actor.control_ref,
          run_id: actor.id,
        }
      : binding,
    ...(preparedInput ? { prepared_assets: preparedInput.prepared.assets } : {}),
    ...(recovery ? { original_site: recovery.site_archive } : {}),
  };
  const files = new Map(
    await Promise.all(
      bootstrapAssetNames.map(
        async (name) => [name, await readFile(path.join(directory, name))] as const,
      ),
    ),
  );
  let verifyPreimage: () => Promise<() => Promise<void>>;
  let preparedPrior: Record<string, unknown> | undefined;
  if (source.purpose === "metadata-renewal") {
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(files.get(bootstrapAssetNames[1])),
    );
    assert.ok(isRecord(raw));
    const receipt = inspectApplicationMetadataPublicationReceipt(
      raw,
      expected.binding,
      expected.custody,
    );
    if (retainedDraft) {
      const retained = retainedServedRenewalFeed;
      assert.equal(expected.release_id, retainedServedRenewal.release_id);
      assert.equal(receipt.site.generation, retained.generation);
      assert.equal(raw.context_sha256, retained.context.context_sha256);
      const proof = applicationDraftAssembly(expected.release_id, raw, receipt.publication, files);
      assert.deepEqual(expected.custody.draft_assemblies, [proof]);
      for (const name of bootstrapAssetNames) {
        assert.equal(files.get(name)!.length, retained.assets[name].bytes);
        assert.equal(sha256(files.get(name)!), retained.assets[name].sha256);
      }
    }
    let priorSite: ReturnType<typeof inspectSiteGeneration>;
    let priorState: Awaited<ReturnType<typeof readActualApplicationPagesState>>;
    let lineage:
      | { release_id: number; custody: ReturnType<typeof inspectApplicationRunCustody> }[]
      | undefined;
    if (preparedInput) {
      assert.equal(preparedInput.prepared.release_id, expected.release_id);
      assert.equal(preparedInput.prepared.site_generation, receipt.site.generation);
      const prior = await readApplicationJson(
        path.join(directory, "prior-site.json"),
        2 * 1024 ** 2,
      );
      assert.ok(isRecord(prior) && prior.schema_version === 1 && prior.authority === "none");
      assert.ok(isRecord(prior.site) && typeof raw.prior_generation === "string");
      priorSite = inspectSiteGeneration(prior.site, raw.prior_generation);
      if (source.renewal_parent !== undefined) {
        assert.ok(
          Array.isArray(prior.lineage) && prior.lineage.length > 0 && prior.lineage.length <= 3,
        );
        lineage = prior.lineage.map((entry: unknown) => {
          assert.ok(
            isRecord(entry) &&
              typeof entry.release_id === "number" &&
              Number.isSafeInteger(entry.release_id) &&
              entry.release_id > 0,
          );
          return {
            release_id: entry.release_id,
            custody: inspectApplicationRunCustody(entry.custody),
          };
        });
        assert.deepEqual(
          { release_id: lineage[0]!.release_id, opportunity: lineage[0]!.custody.opportunity },
          inspectApplicationReleaseReference(source.renewal_parent),
        );
      } else assert.equal(prior.lineage, undefined);
      const discovered = await discoverActualPublishedApplicationCohort(lineage);
      assert.deepEqual(discovered.state, prior.provider);
      priorState = discovered.state;
    } else {
      const scratch = await mkdtemp(
        path.join(process.env.RUNNER_TEMP!, "application-renewal-recovery-"),
      );
      const forward =
        source.renewal_parent === undefined
          ? undefined
          : await readForwardRenewalPreimage(source, scratch);
      lineage = forward?.lineage.map(({ release_id, custody }) => ({ release_id, custody }));
      const { discovered, prior } =
        forward ??
        (await readApplicationPriorPublication(scratch, undefined, "renew-served-metadata"));
      assert.equal(raw.prior_generation, prior.receipt.site.generation);
      assert.equal(raw.prior_repository_sha256, prior.receipt.publication.repository_sha256);
      priorSite = prior.receipt.site;
      priorState = discovered.state;
      preparedPrior = {
        schema_version: 1,
        authority: "none",
        site: priorSite,
        provider: priorState,
        ...(lineage === undefined ? {} : { lineage }),
      };
      if (!retainedDraft)
        await finishDraftRecovery(
          {
            ...expected,
            producer: {
              control_commit: current.source,
              control_ref: current.ref,
              run_id: current.run_id,
              attempt,
            },
          },
          raw,
          receipt.publication,
          files,
          async () => {
            await readPublicApplicationSiteMarker(priorSite);
            assert.deepEqual(await discoverActualPublishedApplicationCohort(lineage), discovered);
            await guardSource();
            return async () => {
              assert.deepEqual(await readActualApplicationPagesState(), priorState);
              assertProtectionWriteWindow();
            };
          },
        );
    }
    verifyPreimage = async () => {
      await readPublicApplicationSiteMarker(priorSite, deadline);
      await guardSource(stage === "publish");
      return async () => {
        assert.deepEqual(await readActualApplicationPagesState(deadline), priorState);
        if (stage === "publish") assertProtectionWriteWindow();
      };
    };
  } else if (stage === "publish") {
    const prior = await readApplicationJson(path.join(directory, "prior-site.json"), 128 * 1024);
    assert.ok(
      isRecord(prior) &&
        Object.keys(prior).sort().join(",") ===
          "authority,inventory_sha256,preimage_sha256,provider,schema_version",
    );
    assert.equal(prior.schema_version, 1);
    assert.equal(prior.authority, "none");
    assert.equal(prior.preimage_sha256, bootstrapAppointment().site_preimage_sha256);
    assert.ok(isRecord(source.bootstrap_preimage) && isRecord(prior.provider));
    assert.equal(prior.inventory_sha256, source.bootstrap_preimage.inventory_sha256);
    const inspected = inspectApplicationMetadataPublicationReceipt(
      JSON.parse(files.get(bootstrapAssetNames[1])!.toString("utf8")),
      expected.binding,
      expected.custody,
    );
    assert.ok(preparedInput);
    assert.equal(preparedInput.prepared.release_id, expected.release_id);
    assert.equal(preparedInput.prepared.site_generation, inspected.site.generation);
    verifyPreimage = async () => {
      assert.deepEqual(await readActualApplicationPagesState(deadline), prior.provider);
      await guardSource();
      return async () => {
        assert.deepEqual(await readActualApplicationPagesState(deadline), prior.provider);
        assertProtectionWriteWindow();
      };
    };
  } else {
    verifyPreimage = async () => {
      const descriptor = await readApplicationJson(
        "release/bootstrap-public-inputs/application/initial-site-preimage.json",
      );
      assert.ok(isRecord(descriptor));
      const scratch = await mkdtemp(
        path.join(process.env.RUNNER_TEMP!, "application-bootstrap-preimage-"),
      );
      const retained = await materializeInitialApplicationRehearsal(
        descriptor,
        bootstrapAppointment().site_preimage_sha256,
        scratch,
      );
      preparedPrior = {
        schema_version: 1,
        authority: "none",
        provider: descriptor.provider,
        preimage_sha256: bootstrapAppointment().site_preimage_sha256,
        inventory_sha256: retained.inventory_sha256,
      };
      await guardSource(stage !== "prepare");
      return async () => {
        assert.deepEqual(await readActualApplicationPagesState(deadline), descriptor.provider);
        if (stage !== "prepare") assertProtectionWriteWindow();
      };
    };
  }
  const deadline = Math.min(coordinatorCommandDeadline() ?? Infinity, performance.now() + 120000);
  publicationStage = "preimage";
  if (stage === "prepare") await (await verifyPreimage())();
  const denyPreparationPublish = () => {
    throw new Error("draft preparation cannot publish");
  };
  publicationStage = "metadata-transport";
  const provider = await createApplicationMetadataPublicationProvider(
    token,
    expected.release_id,
    expected.custody.opportunity,
    stage === "prepare"
      ? denyPreparationPublish
      : () => {
          assertProtectionWriteWindow();
          publicationStage = "release-publication";
        },
    deadline,
  );
  const result = await publishApplicationMetadataRelease(
    {
      async readMetadata(endpoint) {
        const result = await provider.readMetadata(endpoint);
        if (retainedDraft && endpoint.endsWith("/assets?per_page=100&page=1")) {
          assert.ok(Array.isArray(result.body));
          const expectedAsset = retainedServedRenewalFeed.assets["application-site.zip"];
          const assets: unknown[] = result.body;
          const original = assets.find(
            (row: unknown) => isRecord(row) && row.name === "application-site.zip",
          );
          assert.ok(isRecord(original));
          assert.equal(original.id, expectedAsset.id);
          assert.equal(original.size, expectedAsset.bytes);
          assert.equal(original.digest, `sha256:${expectedAsset.sha256}`);
        }
        return result;
      },
      async publish(body) {
        return provider.publish(
          retainedDraft
            ? {
                ...body,
                tag_name: `portcove-production-candidate-${expected.custody.opportunity}`,
                target_commitish: expected.custody.source,
              }
            : body,
        );
      },
      ...(stage === "prepare" && !retainedDraft
        ? {
            async retainAssembly(assembly: ReturnType<typeof applicationDraftAssembly>) {
              return retainApplicationDraftAssembly(
                await createApplicationRunRegistrationProvider(),
                expected,
                current,
                assembly,
                async () => {
                  await guardSource(false);
                },
              );
            },
          }
        : {}),
      async beforeWrite(phase) {
        if (stage === "publish") {
          assert.equal(phase, "publish", "final publication cannot change draft assets");
          return verifyPreimage();
        }
        assert.equal(phase, "asset", "draft preparation cannot publish");
        const prior = preparedPrior;
        assert.ok(prior);
        await guardSource(false);
        return async () => {
          assert.deepEqual(await readActualApplicationPagesState(deadline), prior.provider);
        };
      },
      readAsset: createFixedApplicationReleaseAssetReader(undefined, deadline),
      upload:
        stage === "prepare"
          ? await createApplicationAssetUploader(token, undefined, deadline)
          : async () => {
              throw new Error("final publication cannot upload draft assets");
            },
    },
    expected,
    files.get(bootstrapAssetNames[1])!,
    files.get(bootstrapAssetNames[0])!,
    stage,
  );
  if (stage === "prepare") {
    const output = path.resolve("work/application-draft-prepared");
    await writeApplicationJson(path.join(output, "prepared.json"), {
      schema_version: 1,
      authority: "none",
      kind:
        source.purpose === "metadata-bootstrap"
          ? "application-bootstrap-draft-preparation"
          : "application-renewal-draft-preparation",
      control_commit: current.source,
      control_ref: current.ref,
      run_id: current.run_id,
      producer_attempt: current.run_attempt,
      assembly_attempt: attempt,
      release_id: result.release_id,
      site_generation: result.site_generation,
      assets: result.assets,
    });
    assert.ok(preparedPrior);
    await writeApplicationJson(path.join(output, "prior-site.json"), preparedPrior);
    for (const name of bootstrapAssetNames)
      await writeFile(path.join(output, name), files.get(name)!, { flag: "wx", mode: 0o600 });
    await applicationOutput("attempt", current.run_attempt);
    return;
  }
  await writeApplicationJson("work/application-publication/result.json", result);
  await applicationOutput("release_id", result.release_id);
  await applicationOutput("site_generation", result.site_generation);
  await applicationOutput("attempt", current.run_attempt);
}

async function prepareOrdinaryFeed(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
) {
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  await guard(source, false);
  const current = execution();
  const expected = ordinaryPublicationExpected(source, current.run_attempt);
  const directory = path.resolve("work/application-feed");
  await mkdir(directory);
  const verifier = path.join(directory, "immutable-assets");
  await mkdir(verifier);
  let predecessor: ReturnType<typeof selectApplicationWindowsPredecessor> | undefined;
  let recordSha: string | undefined;
  const input = await readImmutableApplicationRelease(expected, {
    open: (expected, deadline) =>
      createPreparedApplicationPublicationReader(fixedReleaseReaderToken(), expected, deadline),
    async authenticateRelease(identity, deadline) {
      const verified: unknown = JSON.parse(verifyApplicationRelease(identity.tag, deadline));
      inspectApplicationReleaseAttestation(verified, identity);
    },
    readAsset: createFixedApplicationReleaseAssetReader(),
    async authenticateContents(files, inspected) {
      const { producer, producer_attempt: assemblyAttempt } = inspected.receipt;
      for (const name of bootstrapAssetNames)
        await writeFile(path.join(verifier, name), files.get(name)!, { flag: "wx", mode: 0o600 });
      // Preserve the original authenticated TUF assembly and qualification
      // joins at their exact registered producer, including older fixed runs.
      // Provider release inclusion alone supplies no candidate eligibility.
      await verifyReleaseSourceAttestation(
        verifier,
        bootstrapAssetNames[1],
        {
          source_commit: producer.control_commit,
          ref: producer.control_ref,
          run_id: producer.id,
          run_attempt: assemblyAttempt,
          subjects: bootstrapAssetNames.map((filename) => ({
            filename,
            sha256: sha256(files.get(filename)!),
          })),
        },
        { scope: "application-assembly" },
      );
      assertCurrentApplicationPublication(inspected.receipt.publication);
      const { authenticated, actual } = await authenticateApplicationPublicRepository(
        inspected.site_files,
        inspected.receipt.publication,
        verifier,
      );
      const version = expected.custody.preparation?.version;
      assert.ok(version);
      const name = `Portcove_${version}_x64-setup.exe`;
      for (const filename of [name, `${name}.sig`])
        await writeFile(path.join(verifier, filename), files.get(filename)!, {
          flag: "wx",
          mode: 0o600,
        });
      const installer = files.get(name)!;
      await verifyApplicationPayloadSignature(
        version,
        { filename: name, bytes: installer.length, sha256: sha256(installer) },
        verifier,
        verifier,
        verifier,
      );
      const registry = await readApplicationJson(applicationReleaseTrust.payload.path);
      assert.ok(
        isRecord(registry) &&
          Array.isArray(registry.keys) &&
          isRecord(registry.keys[0]) &&
          typeof registry.keys[0].id === "string",
      );
      const recordPath = path.join(
        actual.prepared_root,
        "records",
        "releases",
        version,
        "windows-x86_64",
        "nsis.json",
      );
      const recordBytes = await readFile(recordPath);
      assert.ok(recordBytes.length > 0 && recordBytes.length <= 128 * 1024);
      const record: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(recordBytes),
      );
      assertApplicationPublicationRecord(
        record,
        expected,
        files,
        registry.keys[0].id,
        applicationSourceQualification(source),
      );
      recordSha = sha256(recordBytes);
      const records = new Map<string, Buffer>();
      for (const file of actual.files.filter((entry) =>
        isApplicationWindowsJourneyRecord(entry.path),
      )) {
        const bytes = await readBoundedPublicBuildInputFile(
          actual.prepared_root,
          file.path,
          128 * 1024,
        );
        assert.equal(bytes.length, file.bytes);
        assert.equal(sha256(bytes), file.sha256);
        records.set(file.path, bytes);
      }
      predecessor = selectApplicationWindowsPredecessor(records, version, recordSha);
      await inspectPreparedMetadataRenewal(authenticated);
    },
  });
  const before = await readActualApplicationPagesState();
  try {
    assertBootstrapPagesActor(before, input.site.generation, expected.custody.runs);
    await readPublicApplicationSite(input.site);
    assert.deepEqual(await readActualApplicationPagesState(), before);
    // Desired bytes are already public. Preflight repeats the read-only bracket;
    // any later drift has no missing/initial preimage fallback.
  } catch {
    const { discovered, prior } = await readApplicationPriorPublication(verifier, {
      release_id: expected.release_id,
      custody: expected.custody,
    });
    assert.ok(isRecord(input.metadata));
    assert.equal(prior.receipt.site.generation, input.site.previous_generation);
    assert.equal(prior.receipt.site.generation, input.metadata.prior_generation);
    assert.equal(
      prior.receipt.publication.repository_sha256,
      input.metadata.prior_repository_sha256,
    );
    await readPublicApplicationSite(prior.receipt.site);
    assert.deepEqual(await readActualApplicationPagesState(), discovered.state);
    await writeApplicationJson(path.join(directory, "prior-site.json"), {
      schema_version: 1,
      authority: "none",
      site: prior.receipt.site,
      provider: discovered.state,
    });
  }
  const version = expected.custody.preparation?.version;
  assert.ok(version && recordSha && predecessor !== undefined);
  const windowsCandidate = inspectApplicationWindowsCandidate(
    {
      schema_version: 1,
      kind: "application-windows-candidate",
      authority: "none",
      generation: input.site.generation,
      release_id: expected.release_id,
      record_sha256: recordSha,
      predecessor,
      assets: [`Portcove_${version}_x64-setup.exe`, "portcove-desktop.exe"].map((name) =>
        input.receipt.assets.find((asset) => asset.name === name),
      ),
    },
    expected,
    input.site.generation,
  );
  await writeFeedInput(
    {
      ...input,
      receipt: { ...input.receipt, windows_candidate: windowsCandidate },
    },
    current,
    input.producer_attempt,
  );
}

function assertCurrentApplicationPublication(raw: unknown) {
  const publication = inspectTufPublicationFacts(raw);
  for (const expiration of Object.values(publication.expires))
    assert.ok(
      Date.parse(expiration) > Date.now(),
      "expired metadata cannot advance the public feed",
    );
}

async function authenticateApplicationPublicRepository(
  files: ReadonlyMap<string, Buffer>,
  rawPublication: unknown,
  directory: string,
) {
  const publication = inspectTufPublicationFacts(rawPublication);
  assertCurrentApplicationPublication(publication);
  assert.ok(typeof publication.repository_sha256 === "string");
  const repository = path.join(directory, "repository");
  const output = path.join(directory, "renewal-output");
  await mkdir(repository);
  await mkdir(output);
  for (const [name, bytes] of files) {
    if (!name.startsWith("application/")) continue;
    const destination = path.join(repository, name.slice("application/".length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  const verifier = path.join(toolDirectory, "portcove-release-tools");
  const authenticated = await prepareAuthenticatedMetadataRenewal({
    initial_root_profile: "single-owner-one-of-one-v1",
    verifier,
    verifier_sha256: (await applicationFileIdentity(verifier)).sha256,
    trusted_root: path.resolve(applicationReleaseTrust.root.path),
    trusted_root_sha256: applicationReleaseTrust.root.sha256,
    previous_repository: repository,
    prior_repository_sha256: publication.repository_sha256,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    output_parent: output,
  });
  const actual = await inspectPreparedMetadataRenewal(authenticated);
  assert.deepEqual(actual.descriptor.current_versions, publication.versions);
  assert.deepEqual(actual.descriptor.current_expires, publication.expires);
  return { authenticated, actual };
}

async function writeFeedInput(
  input: Pick<
    Awaited<ReturnType<typeof readImmutableBootstrapFeed>>,
    "files" | "site" | "publication" | "receipt"
  > & { receipt: { windows_candidate?: ReturnType<typeof inspectApplicationWindowsCandidate> } },
  current: ReturnType<typeof execution>,
  attempt: number,
) {
  const directory = path.resolve("work/application-feed");
  const output = path.join(directory, "site");
  await mkdir(output);
  for (const [name, bytes] of input.files) {
    const destination = path.join(output, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  await writeApplicationJson(path.join(directory, "receipt.json"), {
    ...input.receipt,
    control_commit: current.source,
    control_ref: current.ref,
    run_id: current.run_id,
    producer_attempt: current.run_attempt,
    assembly_attempt: attempt,
    site: input.site,
    publication: input.publication,
  });
  await applicationOutput("feed_directory", output);
}

async function verifyRetainedFeedArtifact(
  prior: typeof retainedR56FeedRecovery | typeof retainedV13FeedRecovery,
) {
  const evidence = path.resolve("work/previous-r56-feed-effect");
  const archive = await receiveApplicationData(evidence, {
    id: prior.evidence_artifact_id,
    name: `application-site-publication-${prior.run_id}-1`,
    source: prior.control_commit,
    run_id: prior.run_id,
    files: ["pages-evidence.json"],
    maximum_file_bytes: 4096,
    maximum_archive_bytes: prior.evidence_archive_bytes,
  });
  assert.equal(archive.bytes, prior.evidence_archive_bytes);
  assert.equal(archive.sha256, prior.evidence_archive_sha256);
  const file = path.join(evidence, "pages-evidence.json");
  assert.equal((await applicationFileIdentity(file)).sha256, prior.evidence_sha256);
  requireRetainedR56PreNativeEvidence(await readApplicationJson(file, 4096), prior);
}

async function prepareBootstrapFeed() {
  // All metadata modes re-fetch the immutable Release in key-free staging.
  const source = await readApplicationJson(path.join(sourceDirectory, "source.json"));
  assert.ok(isRecord(source));
  await guard(source, false);
  const current = execution();
  const recoverInitialBootstrap = source.execution_path === "bootstrap-recovery";
  const retainedRecovery =
    current.ref === retainedV13FeedRecovery.next_ref
      ? ("v13" as const)
      : current.ref === retainedR56FeedRecovery.next_ref;
  const recovery = retainedRecovery === "v13" ? retainedV13FeedRecovery : retainedR56FeedRecovery;
  if (retainedRecovery) {
    assert.equal(source.execution_path, "metadata-recovery");
    await verifyRetainedFeedArtifact(recovery);
  }
  const readServing = () =>
    readActualApplicationPagesState(undefined, undefined, false, retainedRecovery);
  const attempt =
    source.purpose === "metadata-bootstrap" && !recoverInitialBootstrap
      ? Number(process.env.PORTCOVE_PUBLICATION_INPUT_ATTEMPT)
      : current.run_attempt;
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  assert.ok(isRecord(source.run_custody));
  const directory = path.resolve("work/application-feed");
  await mkdir(directory);
  const verifier = path.join(directory, "immutable-assets");
  await mkdir(verifier);
  const declared = publicationBinding(source, attempt);
  const binding =
    "purpose" in declared
      ? {
          purpose: declared.purpose,
          opportunity: declared.opportunity,
          prior_generation: declared.prior_generation,
          prior_repository_sha256: declared.prior_repository_sha256,
          ...(declared.renewal_parent === undefined
            ? {}
            : {
                authority_repository_sha256: declared.authority_repository_sha256,
                renewal_parent: declared.renewal_parent,
              }),
        }
      : recoverInitialBootstrap
        ? { ...declared, ...immutableApplicationBootstrap.assembly }
        : declared;
  const input = await readApplicationImmutableFeed(
    {
      release_id: Number(source.run_custody.release_id),
      custody: inspectApplicationRunCustody(source.run_custody.custody),
      binding,
    },
    verifier,
    async (assets, producer, assemblyAttempt) => {
      for (const [name, bytes] of assets)
        await writeFile(path.join(verifier, name), bytes, { flag: "wx", mode: 0o600 });
      await verifyReleaseSourceAttestation(
        verifier,
        bootstrapAssetNames[1],
        {
          source_commit: producer.control_commit,
          ref: producer.control_ref,
          run_id: producer.id,
          run_attempt: assemblyAttempt,
          subjects: [...assets].map(([filename, bytes]) => ({ filename, sha256: sha256(bytes) })),
        },
        { scope: "application-assembly" },
      );
    },
  );
  if (recoverInitialBootstrap) {
    assert.equal(input.site.generation, immutableApplicationBootstrap.generation);
    await authenticateApplicationPublicRepository(input.files, input.publication, verifier);
  }
  if (source.purpose === "metadata-renewal") {
    await authenticateApplicationPublicRepository(input.files, input.publication, verifier);
    const before = await readServing();
    try {
      assertBootstrapPagesActor(
        before,
        input.site.generation,
        inspectApplicationRunCustody(source.run_custody.custody).runs,
      );
      await readPublicApplicationSite(input.site);
      assert.deepEqual(await readServing(), before);
    } catch {
      const lineageDirectory = path.join(verifier, "pending-lineage");
      await mkdir(lineageDirectory);
      const lineage = await readApplicationPendingLineage(
        {
          release_id: Number(source.run_custody.release_id),
          opportunity: String(source.opportunity),
        },
        lineageDirectory,
      );
      assert.equal(
        lineage[0]!.receipt.publication.repository_sha256,
        input.publication.repository_sha256,
      );
      const { discovered, prior } = await readApplicationPriorPublication(
        verifier,
        lineage,
        source.renewal_parent === undefined ? "renew-served-metadata" : undefined,
        retainedRecovery,
      );
      const basis = inspectApplicationRenewalSource(source);
      assert.equal(prior.receipt.site.generation, basis.site_generation);
      assert.equal(input.site.previous_generation, basis.site_generation);
      assert.equal(
        prior.receipt.publication.repository_sha256,
        source.renewal_parent === undefined
          ? basis.repository_sha256
          : source.renewal_public_prior_repository_sha256,
      );
      assertApplicationForwardPreimage(
        lineage[0]!.metadata,
        input.publication,
        prior.receipt.publication,
      );
      await readPublicApplicationSite(prior.receipt.site);
      assert.deepEqual(await readServing(), discovered.state);
      await writeApplicationJson(path.join(directory, "prior-site.json"), {
        schema_version: 1,
        authority: "none",
        site: prior.receipt.site,
        provider: discovered.state,
      });
    }
  }
  await writeFeedInput(input, current, input.producer_attempt);
}

async function captureBootstrapPagesArchive() {
  const source = await readApplicationJson(path.join(sourceDirectory, "source.json"));
  assert.ok(isRecord(source));
  await guard(source, false);
  const current = execution();
  assert.ok(
    ["metadata-bootstrap", "metadata-renewal", "application-release"].includes(
      String(source.purpose),
    ),
  );
  const site = await readApplicationJson("work/application-feed/receipt.json", 2 * 1024 ** 2);
  assert.ok(isRecord(site));
  assert.equal(site.control_commit, current.source);
  assert.equal(site.run_id, current.run_id);
  assert.equal(site.producer_attempt, current.run_attempt);
  assert.ok(process.env.RUNNER_TEMP);
  // This local file was created by the reviewed pinned official upload action
  // from this worker's closed inert tree; it is not an incoming TAR to parse.
  const info = await lstat(path.join(process.env.RUNNER_TEMP, "artifact.tar"));
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size >= 1024 && info.size <= 512 * 1024 ** 2,
  );
  const tar = await readBoundedPublicBuildInputFile(
    process.env.RUNNER_TEMP,
    "artifact.tar",
    info.size,
  );
  const receipt = await verifyApplicationPagesArtifact({
    artifact_id: Number(process.env.PORTCOVE_PAGES_ARTIFACT),
    control_commit: current.source,
    run_id: current.run_id,
    producer_attempt: current.run_attempt,
    tar: { bytes: tar.length, sha256: sha256(tar) },
  });
  await writeApplicationJson("work/application-feed/pages.json", {
    ...receipt,
    site_generation: site.site_generation,
  });
  await applicationOutput("attempt", current.run_attempt);
}

async function preflightBootstrapSite() {
  const source = await loadNativeApplicationSource();
  const hasPrior = source.purpose !== "metadata-bootstrap";
  const recoverInitialBootstrap = source.execution_path === "bootstrap-recovery";
  const current = execution();
  const attempt = current.run_attempt;
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const captured = await readApplicationJson("work/application-feed/pages.json");
  const feed = await readApplicationJson("work/application-feed/receipt.json", 2 * 1024 ** 2);
  assert.ok(
    isRecord(captured) && isRecord(captured.artifact) && isRecord(captured.tar) && isRecord(feed),
  );
  assert.equal(captured.control_commit, current.source);
  assert.equal(captured.run_id, current.run_id);
  assert.equal(captured.producer_attempt, attempt);
  assert.equal(captured.site_generation, feed.site_generation);
  assert.equal(captured.artifact.id, Number(process.env.PORTCOVE_PAGES_ARTIFACT));
  assert.ok(typeof captured.tar.bytes === "number" && typeof captured.tar.sha256 === "string");
  const pages = await verifyApplicationPagesArtifact({
    artifact_id: Number(process.env.PORTCOVE_PAGES_ARTIFACT),
    control_commit: current.source,
    run_id: current.run_id,
    producer_attempt: attempt,
    tar: { bytes: captured.tar.bytes, sha256: captured.tar.sha256 },
  });
  const { site_generation: capturedGeneration, ...captureBody } = captured;
  assert.equal(capturedGeneration, feed.site_generation);
  assert.deepEqual(pages, captureBody);
  assert.ok(isRecord(feed.site) && typeof feed.site.generation === "string");
  const site = inspectSiteGeneration(feed.site, feed.site.generation);
  if (recoverInitialBootstrap) {
    assert.equal(site.generation, immutableApplicationBootstrap.generation);
    assertCurrentApplicationPublication(feed.publication);
    const prior = failedBootstrapRecovery;
    assert.equal(current.ref, prior.next_control_ref);
    const evidence = path.resolve("work/previous-bootstrap-effect");
    const archive = await receiveApplicationData(evidence, {
      id: prior.evidence_artifact_id,
      name: `application-site-publication-${prior.run_id}-${prior.producer_attempt}`,
      source: prior.control_commit,
      run_id: prior.run_id,
      files: ["pages-evidence.json"],
      maximum_file_bytes: 8192,
      maximum_archive_bytes: prior.evidence_artifact_bytes,
    });
    assert.equal(archive.bytes, prior.evidence_artifact_bytes);
    assert.equal(archive.sha256, prior.evidence_artifact_sha256);
    const receipt = await applicationFileIdentity(path.join(evidence, "pages-evidence.json"));
    assert.equal(receipt.sha256, prior.evidence_sha256);
  }
  assert.ok(isRecord(source.run_custody));
  const custody = inspectApplicationRunCustody(source.run_custody.custody);
  const windowsCandidate =
    source.purpose === "application-release"
      ? inspectApplicationWindowsCandidate(
          feed.windows_candidate,
          { release_id: Number(source.run_custody.release_id), custody },
          site.generation,
        )
      : undefined;
  const retainedRecovery =
    current.ref === retainedV13FeedRecovery.next_ref
      ? ("v13" as const)
      : current.ref === retainedR56FeedRecovery.next_ref;
  const recovery = retainedRecovery === "v13" ? retainedV13FeedRecovery : retainedR56FeedRecovery;
  if (retainedRecovery) {
    const prior = recovery;
    assert.equal(source.execution_path, "metadata-recovery");
    assert.equal(site.generation, prior.generation);
    const file = path.resolve("work/previous-r56-feed-effect/pages-evidence.json");
    assert.equal((await applicationFileIdentity(file)).sha256, prior.evidence_sha256);
    requireRetainedR56PreNativeEvidence(await readApplicationJson(file, 4096), prior);
  }
  const readServing = () =>
    readActualApplicationPagesState(
      undefined,
      undefined,
      recoverInitialBootstrap,
      retainedRecovery,
    );
  let preimage;
  try {
    const before = await readServing();
    if (!recoverInitialBootstrap) assertBootstrapPagesActor(before, site.generation, custody.runs);
    await readPublicApplicationSite(site);
    assert.deepEqual(await readServing(), before);
    preimage = { kind: recoverInitialBootstrap ? "recovery-visible" : "desired", provider: before };
  } catch {
    if (hasPrior) {
      const prior = await readApplicationJson("work/application-feed/prior-site.json", 128 * 1024);
      assert.ok(isRecord(prior) && isRecord(prior.site) && isRecord(prior.provider));
      assert.equal(prior.site.generation, site.previous_generation);
      const previous = inspectSiteGeneration(prior.site, site.previous_generation!);
      assert.deepEqual(await readServing(), prior.provider);
      await readPublicApplicationSite(previous);
      assert.deepEqual(
        await readServing(),
        prior.provider,
        "prior site actor changed during ordinary preflight",
      );
      preimage = { kind: "prior", provider: prior.provider, site: previous };
    } else {
      const descriptor = await readApplicationJson(
        "release/bootstrap-public-inputs/application/initial-site-preimage.json",
      );
      assert.ok(isRecord(descriptor));
      await materializeInitialApplicationRehearsal(
        descriptor,
        bootstrapAppointment().site_preimage_sha256,
        path.resolve(process.env.RUNNER_TEMP ?? ""),
        { recoverInitialBootstrap },
      );
      const provider = await readActualApplicationPagesState(
        undefined,
        undefined,
        recoverInitialBootstrap,
      );
      assert.deepEqual(provider, descriptor.provider);
      preimage = { kind: "initial", provider };
    }
  }
  if (retainedRecovery) assert.equal(preimage.kind, "prior");
  const admissionBudget = await guard(source, false);
  const firstControllerBuild =
    hasPrior &&
    preimage.kind === "prior" &&
    current.run_attempt === 1 &&
    admissionBudget.budget.runs.every(
      (run) =>
        run.feed_executions.length === 0 || (retainedRecovery && run.run_id === recovery.run_id),
    ) &&
    (await readApplicationControllerPagesAdmissions(current.source)).length === 0;
  await writeApplicationJson("work/application-site-preflight/plan.json", {
    schema_version: 1,
    kind: hasPrior ? "application-release-site-preflight" : "application-bootstrap-site-preflight",
    authority: "none",
    control_commit: current.source,
    control_ref: current.ref,
    run_id: current.run_id,
    producer_attempt: current.run_attempt,
    opportunity: source.opportunity,
    release_id: Number(source.run_custody.release_id),
    site,
    publication: feed.publication,
    pages,
    pages_intent: applicationPagesIntent(
      site.generation,
      current.run_id,
      current.run_attempt,
      pages.artifact.id,
      recoverInitialBootstrap || firstControllerBuild ? current.source : undefined,
    ),
    ...(recoverInitialBootstrap
      ? { previous_precreate_sha256: failedBootstrapRecovery.evidence_sha256 }
      : {}),
    ...(retainedRecovery ? { previous_precreate_sha256: recovery.evidence_sha256 } : {}),
    preimage,
    ...(windowsCandidate ? { windows_candidate: windowsCandidate } : {}),
  });
  await applicationOutput("attempt", current.run_attempt);
}

async function deployBootstrapSite(readOnly = false) {
  const source = await readNativeApplicationSource();
  const recoverInitialBootstrap = source.execution_path === "bootstrap-recovery";
  publicationStage = "release-guard";
  const markStage = (stage: string) => {
    publicationStage = stage;
  };
  publicationStage = "preflight-input";
  const current = execution();
  const attempt = Number(process.env.PORTCOVE_SITE_PREFLIGHT_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const directory = path.resolve("work/application-site-preflight");
  await receiveApplicationData(directory, {
    id: Number(process.env.PORTCOVE_SITE_PREFLIGHT_ARTIFACT),
    name: `application-site-preflight-${current.run_id}-${attempt}`,
    source: current.source,
    run_id: current.run_id,
    files: ["plan.json"],
    maximum_file_bytes: 2 * 1024 ** 2,
    maximum_archive_bytes: 2 * 1024 ** 2,
  });
  const plan = await readApplicationJson(path.join(directory, "plan.json"), 2 * 1024 ** 2);
  assert.ok(
    isRecord(plan) &&
      plan.schema_version === 1 &&
      plan.kind ===
        (source.purpose !== "metadata-bootstrap"
          ? "application-release-site-preflight"
          : "application-bootstrap-site-preflight") &&
      plan.authority === "none",
  );
  assert.ok(
    ["metadata-bootstrap", "metadata-renewal", "application-release"].includes(
      String(source.purpose),
    ),
  );
  assert.equal(plan.control_commit, current.source);
  assert.equal(plan.control_ref, current.ref);
  assert.equal(plan.run_id, current.run_id);
  assert.equal(plan.producer_attempt, attempt);
  assert.equal(plan.opportunity, source.opportunity);
  assert.ok(isRecord(source.run_custody));
  assert.equal(plan.release_id, source.run_custody.release_id);
  assert.ok(
    isRecord(plan.site) &&
      typeof plan.site.generation === "string" &&
      isRecord(plan.pages) &&
      isRecord(plan.pages.artifact) &&
      isRecord(plan.preimage),
  );
  const site = inspectSiteGeneration(plan.site, plan.site.generation);
  if (recoverInitialBootstrap)
    assert.equal(plan.previous_precreate_sha256, failedBootstrapRecovery.evidence_sha256);
  const retainedRecovery =
    current.ref === retainedV13FeedRecovery.next_ref
      ? ("v13" as const)
      : current.ref === retainedR56FeedRecovery.next_ref;
  const recovery = retainedRecovery === "v13" ? retainedV13FeedRecovery : retainedR56FeedRecovery;
  if (retainedRecovery) {
    assert.equal(source.execution_path, "metadata-recovery");
    assert.equal(site.generation, recovery.generation);
    assert.equal(plan.previous_precreate_sha256, recovery.evidence_sha256);
  }
  assert.equal(site.application_root_sha256, applicationReleaseTrust.root.sha256);
  if (source.purpose === "metadata-bootstrap") {
    assert.equal(site.previous_generation, null);
    if (site.schema_version === 2) assert.equal(site.catalog_root_sha256, null);
  } else {
    assert.match(site.previous_generation!, /^[a-f0-9]{64}$/u);
    assertCurrentApplicationPublication(plan.publication);
  }
  assert.equal(plan.pages.control_commit, current.source);
  assert.equal(plan.pages.run_id, current.run_id);
  const artifact = plan.pages.artifact;
  assert.ok(
    typeof artifact.id === "number" && Number.isSafeInteger(artifact.id) && artifact.id > 0,
  );
  const artifactId = artifact.id;
  assert.ok(isRecord(plan.pages_intent));
  const firstControllerBuild =
    !recoverInitialBootstrap && plan.pages_intent.build_version === current.source;
  const usePreflightPriorBytes =
    firstControllerBuild &&
    source.purpose === "application-release" &&
    source.execution_path === undefined;
  if (firstControllerBuild) {
    assert.equal(plan.preimage.kind, "prior");
    assert.ok(source.purpose === "application-release" || source.purpose === "metadata-renewal");
    assert.equal(attempt, 1);
    assert.equal(current.run_attempt, 1);
  }
  const intent = applicationPagesIntent(
    site.generation,
    current.run_id,
    attempt,
    artifactId,
    recoverInitialBootstrap || firstControllerBuild ? current.source : undefined,
  );
  assert.deepEqual(plan.pages_intent, intent);
  const preimageKind = plan.preimage.kind;
  assert.ok(
    preimageKind === "initial" ||
      preimageKind === "prior" ||
      preimageKind === "desired" ||
      (recoverInitialBootstrap && preimageKind === "recovery-visible"),
  );
  assert.ok(
    source.purpose === "metadata-bootstrap" ? preimageKind !== "prior" : preimageKind !== "initial",
  );
  const preimage = plan.preimage;
  const custody = inspectApplicationRunCustody(source.run_custody.custody);
  const windowsCandidate =
    source.purpose === "application-release"
      ? inspectApplicationWindowsCandidate(
          plan.windows_candidate,
          { release_id: Number(source.run_custody.release_id), custody },
          site.generation,
        )
      : undefined;
  if (retainedRecovery)
    assert.ok(
      firstControllerBuild,
      "retained feed recovery requires exact new controller admission",
    );
  const priorRuns = (facts: Awaited<ReturnType<typeof guard>>) =>
    facts.budget.runs.filter(
      (run) =>
        (!recoverInitialBootstrap || run.run_id !== current.run_id) &&
        (!retainedRecovery || run.run_id !== recovery.run_id) &&
        run.feed_executions.length > 0,
    );
  // The scoped create paths perform their complete live budget read after
  // OIDC and before the effect. Read-only lookups cannot grant a write.
  const controls =
    readOnly || (!recoverInitialBootstrap && !firstControllerBuild)
      ? await guard(source, false, { markStage })
      : undefined;
  const prior = controls ? priorRuns(controls) : [];
  const original = immutableApplicationBootstrap;
  const assertRecovery = (facts: Awaited<ReturnType<typeof guard>>) => {
    assert.equal(source.purpose, "metadata-bootstrap");
    assert.equal(plan.release_id, original.release_id);
    assert.equal(site.generation, original.generation);
    assert.notEqual(current.source, original.assembly.control_commit);
    assert.equal(current.ref, failedBootstrapRecovery.next_control_ref);
    assert.equal(current.run_attempt, 1);
    const previous = new Map(priorRuns(facts).map((run) => [run.run_id, run]));
    const expected = [{ ...original, ...original.assembly }, failedBootstrapRecovery];
    assert.equal(previous.size, expected.length);
    for (const execution of expected) {
      const run = previous.get(execution.run_id);
      assert.ok(run);
      assert.equal(run.feed_executions.length, 1);
      const feed = run.feed_executions[0]!;
      assert.equal(feed.job_id, execution.feed_job_id);
      assert.equal(feed.attempt, execution.producer_attempt);
      assert.equal(feed.conclusion, "failure");
    }
    const ended = previous.get(original.assembly.run_id)?.feed_executions[0]?.completed_at;
    assert.ok(Date.now() - Date.parse(String(ended)) >= 10 * 60_000);
    assertCurrentApplicationPublication(plan.publication);
  };
  if (recoverInitialBootstrap && controls) assertRecovery(controls);
  const deadline =
    performance.now() + (recoverInitialBootstrap && !readOnly ? 13 * 60_000 : 90_000);
  const requests: PagesRequestEvidence[] = [];
  const provider = createPagesProviderTransport(
    { evidence: (entry) => requests.push(entry) },
    deadline,
  );
  if (readOnly && (recoverInitialBootstrap || firstControllerBuild)) {
    const publicationDirectory = path.resolve("work/application-feed-execution");
    await receiveApplicationData(publicationDirectory, {
      id: Number(process.env.PORTCOVE_SITE_PUBLICATION_ARTIFACT),
      name: `application-site-publication-${current.run_id}-${attempt}`,
      source: current.source,
      run_id: current.run_id,
      files: ["pages-evidence.json", "result.json"],
      maximum_file_bytes: 128 * 1024,
      maximum_archive_bytes: 256 * 1024,
    });
    const evidence = await readApplicationJson(
      path.join(publicationDirectory, "pages-evidence.json"),
    );
    const effect = await readApplicationJson(path.join(publicationDirectory, "result.json"));
    assert.ok(isRecord(evidence) && Array.isArray(evidence.requests) && isRecord(effect));
    assert.deepEqual(evidence.intent, intent);
    assert.ok(
      recoverInitialBootstrap
        ? effect.resolution === "continued-identical-effect" ||
            effect.resolution === "recovered-original-effect"
        : effect.resolution === "new-effect" || effect.resolution === "recovered-ambiguous-effect",
    );
    assert.equal(effect.generation, site.generation);
    const adopted = effect.resolution === "recovered-original-effect";
    const shaReadback = firstControllerBuild && effect.resolution === "recovered-ambiguous-effect";
    const id = adopted
      ? original.generation
      : shaReadback
        ? intent.build_version
        : effect.native_deployment_id;
    assert.ok(typeof id === "string");
    if (adopted) {
      assert.equal(effect.prior_outcome, "succeeded");
      assert.equal(preimageKind, "recovery-visible");
    } else if (shaReadback) {
      assert.equal(effect.native_deployment_id, null);
      const creates = evidence.requests.filter(
        (request) => isRecord(request) && request.stage === "create",
      );
      assert.equal(creates.length, 1);
      assert.ok(
        isRecord(creates[0]) &&
          creates[0].id === id &&
          creates[0].status === 200 &&
          isRecord(creates[0].acknowledgement_refusal),
      );
    } else {
      assert.notEqual(id, original.generation);
      assert.ok(
        evidence.requests.some(
          (request) =>
            isRecord(request) &&
            request.stage === "acknowledged" &&
            request.id === id &&
            request.status === 200,
        ),
      );
    }
    const native = await provider.status({
      id,
      generation: site.generation,
      artifact_id: adopted ? original.pages_artifact_id : artifactId,
      controller_revision: adopted ? original.assembly.control_commit : current.source,
    });
    assert.equal(native.outcome, "succeeded", "continuation no longer has positive native success");
  }
  let admissionId: number | undefined;
  const verifyServingActor = async () => {
    const { admission_id, ...serving } = await readActualApplicationPagesState(
      deadline,
      {
        ...current,
        selection: "serving",
        ...(admissionId === undefined ? {} : { deployment_id: admissionId }),
      },
      recoverInitialBootstrap,
      retainedRecovery,
    );
    assert.ok(admission_id !== undefined);
    assert.deepEqual(serving, preimage.provider, "public deployment changed after preflight");
    admissionId = admission_id;
  };
  const priorEffect =
    recoverInitialBootstrap || prior.length > 0
      ? {
          identity: {
            id: site.generation,
            generation: site.generation,
            artifact_id: recoverInitialBootstrap ? original.pages_artifact_id : artifactId,
            controller_revision: recoverInitialBootstrap
              ? original.assembly.control_commit
              : current.source,
          },
          qualified_native_id: false,
          ...(recoverInitialBootstrap
            ? {
                continuation: {
                  build_version: intent.build_version,
                  async beforeCancel() {
                    throw new Error(
                      "The original bootstrap build version has no qualified native ID",
                    );
                  },
                },
              }
            : {}),
        }
      : undefined;
  const execute = () =>
    executeBootstrapPages(
      {
        artifact_id: artifactId,
        control_commit: current.source,
        site,
        ...(priorEffect ? { prior_effect: priorEffect } : {}),
        ...(firstControllerBuild && !readOnly ? { first_controller_build: true } : {}),
        preimage: readOnly ? "desired" : preimageKind,
      },
      {
        provider,
        deadline,
        markStage,
        ...(recoverInitialBootstrap && !readOnly
          ? {
              async beforeCancelNewEffect() {
                assert.ok(admissionId !== undefined);
                const active = await readActualApplicationPagesState(deadline, {
                  ...current,
                  selection: "current",
                  deployment_id: admissionId,
                });
                assert.equal(active.admission_id, admissionId);
              },
            }
          : {}),
        async beforeWrite() {
          assert.equal(readOnly, false, "public readback has no deployment authority");
          const fresh = await guard(source, true, { markStage });
          if (recoverInitialBootstrap) {
            assertRecovery(fresh);
            for (const expiration of Object.values(
              inspectTufPublicationFacts(plan.publication).expires,
            ))
              assert.ok(
                Date.parse(expiration) - Date.now() > 16 * 60_000,
                "bootstrap roles lack recovery headroom",
              );
          } else
            assert.equal(
              priorRuns(fresh).length,
              0,
              "earlier feed execution requires read-only recovery",
            );
          if (source.purpose !== "metadata-bootstrap")
            assertCurrentApplicationPublication(plan.publication);
          return assertProtectionWriteWindow;
        },
        async assertPreimage() {
          await verifyServingActor();
          const provider = await createReleaseCustodyProvider({
            token: fixedReleaseReaderToken(),
            deadline,
            requestTimeoutMs: 30000,
            maxBytes: 8 * 1024 ** 2,
            beforeDispatch: () => assertTrustedDirectNode("fixed application Pages artifact read"),
          });
          const observed = await provider.artifact(artifactId);
          assert.ok(
            isRecord(observed) && observed.expired === false && isRecord(observed.workflow_run),
          );
          assert.equal(observed.id, artifact.id);
          assert.equal(observed.name, artifact.name);
          assert.equal(observed.size_in_bytes, artifact.bytes);
          assert.equal(observed.digest, `sha256:${String(artifact.sha256)}`);
          assert.equal(observed.workflow_run.head_sha, current.source);
          assert.equal(observed.workflow_run.id, Number(current.run_id));
          if (preimageKind === "prior") {
            assert.ok(isRecord(preimage.site));
            const previous = inspectSiteGeneration(preimage.site, site.previous_generation!);
            // Preparation authenticated the complete predecessor between the
            // same serving actor observations under the shared publisher group.
            if (usePreflightPriorBytes) await readPublicApplicationSiteMarker(previous, deadline);
            else await readPublicApplicationSite(previous, deadline);
            await verifyServingActor();
            if (firstControllerBuild)
              assert.deepEqual(
                await readApplicationControllerPagesAdmissions(current.source, deadline),
                [admissionId],
                "controller SHA already has a Pages admission",
              );
            assertCurrentApplicationPublication(plan.publication);
            return;
          }
          if (recoverInitialBootstrap) {
            assert.ok(admissionId !== undefined);
            const descriptor = await readApplicationJson(
              "release/bootstrap-public-inputs/application/initial-site-preimage.json",
            );
            assert.ok(isRecord(descriptor) && Array.isArray(descriptor.files));
            for (const file of descriptor.files)
              assert.ok(site.files.some((entry) => isDeepStrictEqual(entry, file)));
            await materializeInitialApplicationRehearsal(
              descriptor,
              bootstrapAppointment().site_preimage_sha256,
              path.resolve(process.env.RUNNER_TEMP ?? ""),
              {
                deadline,
                recoverInitialBootstrap,
                admission: { ...current, selection: "serving", deployment_id: admissionId },
              },
            );
            assertCurrentApplicationPublication(plan.publication);
          }
          const missing = await fetch("https://boburning.github.io/portcove/publication.json", {
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          await missing.body?.cancel();
          assert.equal(missing.url, "https://boburning.github.io/portcove/publication.json");
          assert.equal(missing.status, 404, "bootstrap marker appeared after initial preflight");
          await verifyServingActor();
        },
        async providerReadback(resolution) {
          // Native Pages success is already checked for this artifact and generation.
          // The following readback job independently requires final Actions success.
          const adopted = recoverInitialBootstrap && resolution === "recovered-original-effect";
          if (adopted) {
            assert.equal(preimageKind, "recovery-visible");
            assertRecovery(await guard(source, false, { markStage }));
            await verifyServingActor();
          }
          const newEffect =
            adopted ||
            resolution === "new-effect" ||
            resolution === "recovered-ambiguous-effect" ||
            resolution === "continued-identical-effect";
          if (newEffect) assert.ok(admissionId !== undefined);
          const state = await readActualApplicationPagesState(
            deadline,
            readOnly
              ? undefined
              : {
                  ...current,
                  selection: newEffect ? "current" : "serving",
                  ...(admissionId === undefined ? {} : { deployment_id: admissionId }),
                },
          );
          assertBootstrapPagesActor(state, site.generation, custody.runs);
          if (readOnly && (recoverInitialBootstrap || firstControllerBuild)) {
            const settled = await readApplicationPagesExecution(
              await createApplicationFeedReader(fixedReleaseReaderToken(), deadline),
              state,
              { ...current, first_controller_build: firstControllerBuild },
            );
            assert.equal(settled.run.id, current.run_id);
            assert.equal(settled.run.control_commit, current.source);
            assert.equal(settled.run.control_ref, current.ref);
            assert.equal(settled.attempt, current.run_attempt);
            assert.equal(settled.conclusion, "success");
          }
          return state;
        },
        async publicReadback() {
          const receipt = await readPublicApplicationSite(site, deadline);
          if (recoverInitialBootstrap) assertCurrentApplicationPublication(plan.publication);
          return receipt;
        },
        wait: () => pause(recoverInitialBootstrap ? 4000 : 2000),
      },
    );
  let result: Awaited<ReturnType<typeof executeBootstrapPages>>;
  try {
    result = await execute();
  } finally {
    if (!readOnly)
      await writeApplicationJson("work/application-site-publication/pages-evidence.json", {
        schema_version: 1,
        intent,
        stage: publicationStage,
        prior_effect: priorEffect?.identity ?? null,
        requests,
      });
  }
  await writeApplicationJson("work/application-site-publication/result.json", result);
  if (readOnly && windowsCandidate) {
    const preparation = custody.preparation;
    assert.ok(preparation?.qualification);
    await applicationOutput("windows_has_predecessor", windowsCandidate.predecessor !== null);
    await writeApplicationJson("work/application-site-publication/windows-candidate.json", {
      schema_version: 1,
      kind: "application-windows-installed-input",
      authority: "none",
      candidate: windowsCandidate,
      prepared_commit: preparation.prepared_commit,
      prepared_tree: preparation.prepared_tree,
      qualification: preparation.qualification,
      publication: inspectTufPublicationFacts(plan.publication),
      public_readback_sha256: result.evidence_sha256,
      control_commit: current.source,
      control_ref: current.ref,
      run_id: current.run_id,
      run_attempt: current.run_attempt,
    });
  }
  await applicationOutput("attempt", current.run_attempt);
  await applicationOutput("site_generation", site.generation);
}

/** Windows consumer acquisition only. Release and Pages reads are repeated
 * here before any ordinary-account harness may receive candidate bytes. */
export async function preparePublicWindowsCandidate(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  deadline?: number,
) {
  const current = execution();
  assert.equal(source.purpose, "application-release");
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  await guard(source, false);
  const expected = ordinaryPublicationExpected(source, current.run_attempt);
  const preparation = expected.custody.preparation;
  assert.ok(preparation?.qualification);
  const attempt = Number(process.env.PORTCOVE_WINDOWS_CANDIDATE_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const runJobs = await readApplicationAttemptJobs(current.run_id, attempt, deadline);
  assert.ok(isRecord(runJobs) && Array.isArray(runJobs.jobs) && runJobs.jobs.length < 100);
  assert.equal(runJobs.total_count, runJobs.jobs.length);
  const producers = runJobs.jobs.filter((job: unknown) => isRecord(job) && job.name === "readback");
  assert.equal(producers.length, 1);
  const producer: unknown = producers[0];
  assert.ok(
    isRecord(producer) && producer.status === "completed" && producer.conclusion === "success",
  );
  assert.equal(producer.run_id, Number(current.run_id));
  assert.equal(producer.run_attempt, attempt);
  assert.equal(producer.head_sha, current.source);
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP!, "application-public-windows-"));
  const inputDir = path.join(scratch, "candidate");
  const readbackDir = path.join(scratch, "readback");
  const shared = {
    run_id: current.run_id,
    source: current.source,
    maximum_file_bytes: 2 * 1024 ** 2,
    maximum_archive_bytes: 2 * 1024 ** 2,
  };
  await receiveApplicationData(inputDir, {
    ...shared,
    id: Number(process.env.PORTCOVE_WINDOWS_CANDIDATE_ARTIFACT),
    name: `application-windows-candidate-${current.run_id}-${attempt}`,
    files: ["windows-candidate.json"],
  });
  await receiveApplicationData(readbackDir, {
    ...shared,
    id: Number(process.env.PORTCOVE_WINDOWS_READBACK_ARTIFACT),
    name: `application-site-readback-${current.run_id}-${attempt}`,
    files: ["result.json"],
  });
  const input = await readApplicationJson(
    path.join(inputDir, "windows-candidate.json"),
    128 * 1024,
  );
  const readback = await readApplicationJson(path.join(readbackDir, "result.json"), 2 * 1024 ** 2);
  assert.ok(isRecord(input) && isRecord(readback));
  assert.equal(
    Object.keys(input).sort().join(","),
    "authority,candidate,control_commit,control_ref,kind,prepared_commit,prepared_tree,public_readback_sha256,publication,qualification,run_attempt,run_id,schema_version",
  );
  assert.equal(input.schema_version, 1);
  assert.equal(input.kind, "application-windows-installed-input");
  assert.equal(input.authority, "none");
  assert.equal(input.control_commit, current.source);
  assert.equal(input.control_ref, current.ref);
  assert.equal(input.run_id, current.run_id);
  assert.equal(input.run_attempt, attempt);
  assert.equal(input.prepared_commit, preparation.prepared_commit);
  assert.equal(input.prepared_tree, preparation.prepared_tree);
  assert.deepEqual(input.qualification, applicationSourceQualification(source));
  const { discovered, prior } = await readApplicationPriorPublication(scratch);
  const site = prior.receipt.site;
  assert.equal(discovered.release_id, expected.release_id);
  assert.equal(site.application_root_sha256, applicationReleaseTrust.root.sha256);
  assert.deepEqual(inspectTufPublicationFacts(input.publication), prior.receipt.publication);
  assertCurrentApplicationPublication(prior.receipt.publication);
  assert.equal(readback.generation, site.generation);
  assert.equal(readback.authority, "none");
  assert.equal(readback.schema_version, 1);
  assert.deepEqual(readback.provider, discovered.state);
  assert.equal(input.public_readback_sha256, readback.evidence_sha256);
  const transport: Parameters<typeof readApplicationWindowsCandidateAssets>[3] = {
    deadline: deadline ?? Infinity,
    open: (expected, phaseDeadline) =>
      createPreparedApplicationPublicationReader(
        fixedReleaseReaderToken(),
        expected,
        phaseDeadline,
      ),
    async readReleaseByTag(tag, phaseDeadline) {
      const provider = await createReleaseCustodyProvider({
        token: fixedReleaseReaderToken(),
        deadline: phaseDeadline,
        maxBytes: 8 * 1024 ** 2,
        requestTimeoutMs: 30000,
        beforeDispatch: () => assertTrustedDirectNode("fixed application predecessor Release"),
      });
      return provider.releaseByTag(tag);
    },
    async authenticateRelease(identity, deadline) {
      const verified: unknown = JSON.parse(verifyApplicationRelease(identity.tag, deadline));
      inspectApplicationReleaseAttestation(verified, identity);
    },
    readAsset: createFixedApplicationReleaseAssetReader(undefined, deadline),
  };
  const checked = await readApplicationWindowsCandidateAssets(
    input.candidate,
    expected,
    site.generation,
    transport,
  );
  assert.equal(
    site.files.filter(
      (file) =>
        file.path.startsWith("application/targets/") &&
        file.sha256 === checked.candidate.record_sha256,
    ).length,
    1,
    "verified public generation does not contain the exact Windows release record",
  );
  if (checked.candidate.predecessor) {
    const previous = checked.candidate.predecessor;
    for (const digest of [previous.record_sha256, previous.promotion_sha256])
      assert.equal(
        site.files.filter(
          (file) => file.path.startsWith("application/targets/") && file.sha256 === digest,
        ).length,
        1,
        "verified public generation does not contain the exact predecessor records",
      );
  }
  const previousFiles = checked.candidate.predecessor
    ? await readApplicationWindowsPredecessorAssets(checked.candidate.predecessor, transport)
    : undefined;
  const predecessor = checked.candidate.predecessor;
  const ordinaryInputs =
    predecessor && previousFiles
      ? {
          schema_version: 1,
          kind: "ordinary-public-windows-update-inputs",
          prior_version: predecessor.version,
          prior_installer_sha256: predecessor.installer_sha256,
          prior_executable_sha256: projectWindowsNsisExecutable(
            previousFiles.get("portcove-desktop.exe")!,
          ).nsis_sha256,
          candidate_version: preparation.version,
          candidate_installer_sha256: checked.candidate.assets[0]!.sha256,
          candidate_executable_sha256: projectWindowsNsisExecutable(
            checked.files.get("portcove-desktop.exe")!,
          ).nsis_sha256,
        }
      : undefined;
  const actual = await readPublicApplicationSite(site);
  assert.deepEqual(actual, readback.public_readback);
  assert.equal(
    readback.evidence_sha256,
    releaseCanonicalDigest({
      generation: site.generation,
      provider: discovered.state,
      readback: actual,
    }),
  );
  const assertCurrentSite = async () => {
    await guard(source, false);
    await readPublicApplicationSiteMarker(site);
    assert.deepEqual(await readActualApplicationPagesState(), discovered.state);
    assertCurrentApplicationPublication(prior.receipt.publication);
  };
  await assertCurrentSite();
  const output = path.resolve("work/application-windows-consumer-input");
  await mkdir(output);
  for (const [name, bytes] of checked.files)
    await writeFile(path.join(output, name), bytes, { flag: "wx", mode: 0o600 });
  if (previousFiles) {
    const predecessor = path.join(output, "predecessor");
    await mkdir(predecessor);
    for (const [name, bytes] of previousFiles)
      await writeFile(path.join(predecessor, name), bytes, { flag: "wx", mode: 0o600 });
  }
  if (ordinaryInputs)
    await writeApplicationJson(path.join(output, "ordinary-public-inputs.json"), ordinaryInputs);
  await writeApplicationJson(path.join(output, "verified.json"), {
    ...input,
    candidate: checked.candidate,
    ...(previousFiles
      ? {
          predecessor_executable_sha256: sha256(previousFiles.get("portcove-desktop.exe")!),
        }
      : {}),
    scope: "verified current public feed and candidate bytes; no installed execution",
  });
  return { directory: output, candidate: checked.candidate, ordinaryInputs, assertCurrentSite };
}

async function verifyPublicWindowsInstalled() {
  const current = execution();
  const source = await readNativeApplicationSource();
  const attempt = Number(process.env.PORTCOVE_WINDOWS_PROOF_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const producer = async () =>
    inspectApplicationPublicInstalledProducer(
      await readApplicationAttemptJobs(current.run_id, attempt),
      { run_id: current.run_id, run_attempt: attempt, source: current.source },
    );
  const job = await producer();
  const acquired = await preparePublicWindowsCandidate(source);
  assert.ok(acquired.ordinaryInputs, "installed proof requires an actual public predecessor");
  const directory = path.resolve("work/application-public-installed-readback");
  const artifact = await receiveApplicationData(directory, {
    id: Number(process.env.PORTCOVE_WINDOWS_PROOF_ARTIFACT),
    name: `application-public-installed-${current.run_id}-${attempt}`,
    source: current.source,
    run_id: current.run_id,
    files: ["public-installed.json", "installer.json", "public-update-journey.json"],
    maximum_file_bytes: 4 * 1024 ** 2,
    maximum_archive_bytes: 12 * 1024 ** 2,
  });
  const minimum = process.env.PORTCOVE_APPLICATION_NATIVE_MINIMUM_PLATFORM;
  assert.ok(minimum === "windows-11-26h2-x64" || minimum === "windows-server-2022-x64-continuity");
  const result = inspectApplicationPublicInstalledProof(
    await readApplicationJson(path.join(directory, "public-installed.json"), 128 * 1024),
    await readApplicationJson(path.join(directory, "installer.json"), 4 * 1024 ** 2),
    await readApplicationJson(path.join(directory, "public-update-journey.json"), 4 * 1024 ** 2),
    {
      source: current.source,
      ref: current.ref,
      run_id: current.run_id,
      run_attempt: attempt,
      producer: job,
      candidate: acquired.candidate,
      inputs: acquired.ordinaryInputs,
      minimum,
      inputs_sha256: (
        await applicationFileIdentity(path.join(acquired.directory, "ordinary-public-inputs.json"))
      ).sha256,
      harness_sha256: (
        await applicationFileIdentity("apps/desktop/scripts/desktop-windows-public-update.mts")
      ).sha256,
    },
  );
  assert.deepEqual(await producer(), job);
  await acquired.assertCurrentSite();
  await writeApplicationJson("work/application-public-installed-verified/result.json", {
    schema_version: 1,
    kind: "application-public-installed-readback",
    ...result,
    artifact,
    control_commit: current.source,
    run_id: current.run_id,
    release_id: acquired.candidate.release_id,
    generation: acquired.candidate.generation,
  });
}

async function observe() {
  let stage = "source";
  try {
    const current = execution();
    const source = await readNativeApplicationSource();
    const phase = process.env.PORTCOVE_PROTECTION_PHASE ?? "";
    stage = "release-guard";
    await guard(source, false, {
      useVerifiedSourceCustody: phase !== "feed",
      markStage(next) {
        stage = next;
      },
    });
    stage = "reader-setup";
    // This process alone has the existing Administration-write App token. The
    // collector issues GETs only; no signing or publication key is present here.
    assert.equal(process.env.PORTCOVE_OBSERVER_INSTALLATION_ID, "177226788");
    assert.ok(
      [
        "payload",
        "metadata",
        "metadata-releases",
        "metadata-preview",
        "metadata-stable",
        "snapshot",
        "timestamp",
        "draft-recovery",
        "publication",
        "feed",
      ].includes(phase),
    );
    const token = process.env.PORTCOVE_OBSERVER_TOKEN;
    assert.ok(token && !/[\r\n\0]/u.test(token) && token.length <= 16384);
    const renewalMaintenance =
      source.purpose === "metadata-renewal" && source.execution_path === "metadata-maintenance";
    if (phase.startsWith("metadata-")) assert.ok(renewalMaintenance);
    if (renewalMaintenance && metadataProtectionPhase(phase)) {
      stage = "metadata-consumer-admission";
      await waitForMetadataProtectionConsumer(current, phase);
    }
    const observer = await createApplicationProtectionObservationReader({
      refToken: fixedReleaseReaderToken(),
      token,
      deadline: performance.now() + 120000,
      maxBytes: 4 * 1024 ** 2,
      requestTimeoutMs: 30000,
      guard: () => assertTrustedDirectNode("fixed application protection observer"),
    });
    stage = "inventory-read";
    const observation = await observeReleaseInputProtections(observer, {
      releasePublication: true,
    });
    stage = "protection-policy";
    const bootstrap = source.purpose === "metadata-bootstrap";
    const digest = requireApplicationReleaseProtectionDigest(observation, bootstrap);
    stage = "protection-appointment";
    const appointed = process.env.PORTCOVE_APPLICATION_RELEASE_PROTECTION_SHA256;
    if (bootstrap && digest !== appointed)
      console.error(
        JSON.stringify({
          kind: "bootstrap-protection-fingerprints",
          ...bootstrapProtectionFingerprints(observation),
        }),
      );
    assert.equal(digest, appointed);
    stage = "receipt-write";
    await writeApplicationJson("work/application-protection/protection.json", {
      schema_version: 1,
      phase,
      source: current.source,
      run_id: current.run_id,
      attempt: current.run_attempt,
      observation,
    });
    await applicationOutput("attempt", current.run_attempt);
  } catch (error) {
    const status =
      error instanceof GitHubApiError &&
      typeof error.status === "number" &&
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? ` (HTTP ${error.status})`
        : "";
    const limited =
      error instanceof GitHubApiError && error.code === "rate_limited" ? " (rate limited)" : "";
    console.error(`Application protection observation refused at ${stage}${status}${limited}.`);
    throw error;
  }
}

export async function receiveNativePackages(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
) {
  const current = execution();
  assert.equal(source.purpose, "application-release");
  const prepared = source.prepared;
  assert.ok(
    isRecord(prepared) &&
      typeof prepared.prepared_commit === "string" &&
      typeof prepared.prepared_tree === "string" &&
      typeof prepared.version === "string",
  );
  return receiveApplicationPackages(path.resolve("work/application-unsigned"), {
    source_commit: prepared.prepared_commit,
    source_tree: prepared.prepared_tree,
    version: prepared.version,
    control_commit: current.source,
    control_ref: current.ref,
    run_id: current.run_id,
    package_attempt: Number(process.env.PORTCOVE_PACKAGE_ATTEMPT),
    provenance_attempt: Number(process.env.PORTCOVE_PROVENANCE_ATTEMPT),
    artifact: Number(process.env.PORTCOVE_UNSIGNED_ARTIFACT),
  });
}

/** Fresh, key-free attester: original native work is never launched here.
 * Raw observations are admitted only after complete independent reconstruction
 * and successful original producer chronology, then copied as three data files. */
async function attestNative() {
  const current = execution();
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  const source = await readNativeApplicationSource();
  const received = await receiveNativePackages(source);
  await readNativePayloadAcceptance(source, received, "raw");
  await guard(source, false, { useVerifiedSourceCustody: true });
  const output = path.resolve("work/application-native-attested");
  await mkdir(output);
  for (const filename of applicationNativeFiles)
    await writeFile(
      path.join(output, filename),
      await readFile(path.resolve("work/application-native", filename)),
      { flag: "wx" },
    );
  await applicationOutput("attempt", current.run_attempt);
}

async function payload() {
  const current = execution();
  const source = await readNativeApplicationSource();
  const received = await receiveNativePackages(source);
  const prepared = source.prepared;
  assert.ok(
    isRecord(prepared) &&
      typeof prepared.version === "string" &&
      typeof prepared.prepared_commit === "string",
  );
  const { qualification: nativeReport, ...native } = await readNativePayloadAcceptance(
    source,
    received,
  );
  const controls = await guard(source, true, { useVerifiedSourceCustody: true });
  const output = path.resolve("work/application-signature");
  const secretDirectory = path.join(process.env.RUNNER_TEMP ?? "", "application-payload-key");
  assert.ok(path.isAbsolute(secretDirectory));
  await mkdir(output);
  await mkdir(secretDirectory, { mode: 0o700 });
  const keyFile = path.join(secretDirectory, "payload.key");
  const name = `Portcove_${prepared.version}_x64-setup.exe`;
  const payloadFile = path.resolve("work/application-unsigned", name);
  try {
    const key = process.env.PORTCOVE_SIGNING_KEY;
    assert.ok(
      typeof key === "string" && Buffer.byteLength(key) > 0 && Buffer.byteLength(key) <= 16384,
    );
    await writeFile(keyFile, key, { flag: "wx", mode: 0o600 });
    const invoke = (args: string[]) =>
      execFileSync(process.execPath, [path.join(toolDirectory, "tauri.js"), ...args], {
        env: payloadSigningEnvironment(secretDirectory),
        timeout: 120000,
        stdio: "pipe",
        maxBuffer: 65536,
      });
    assert.equal(
      invoke(["--version"]).toString().trim(),
      `tauri-cli ${fixedReleaseToolDependencies().tauri}`,
    );
    assertProtectionWriteWindow();
    invoke([
      "signer",
      "sign",
      "--private-key-path",
      keyFile,
      "--password",
      "",
      "--app-version",
      prepared.version,
      payloadFile,
    ]);
    const registry: unknown = JSON.parse(
      await readFile(applicationReleaseTrust.payload.path, "utf8"),
    );
    assert.ok(
      isRecord(registry) &&
        Array.isArray(registry.keys) &&
        isRecord(registry.keys[0]) &&
        typeof registry.keys[0].id === "string" &&
        typeof registry.keys[0].tauri_public_key === "string",
    );
    const publicFile = path.join(output, "payload.pub");
    await writeFile(publicFile, registry.keys[0].tauri_public_key, { flag: "wx" });
    const identity = received.manifest.files.find((file) => file.filename === name);
    assert.ok(identity);
    execFileSync(
      path.join(toolDirectory, "portcove-release-tools"),
      [
        "verify",
        payloadFile,
        `${payloadFile}.sig`,
        publicFile,
        identity.sha256,
        String(identity.bytes),
      ],
      {
        env: payloadSigningEnvironment(secretDirectory),
        timeout: 120000,
        stdio: "pipe",
        maxBuffer: 65536,
      },
    );
    const signature = await readFile(`${payloadFile}.sig`);
    const box = Buffer.from(signature.toString("utf8").trim(), "base64").toString("utf8");
    const comment = box.trim().split(/\r?\n/u)[2];
    assert.ok(
      comment?.startsWith("trusted comment: timestamp:") &&
        comment.endsWith(`\tfile:${name}\tversion:${prepared.version}`),
    );
    await writeFile(path.join(output, `${name}.sig`), signature, { flag: "wx" });
    await writeApplicationJson(
      path.join(output, "updater-inventory.json"),
      createApplicationUpdaterInventory(
        received.manifest,
        nativeReport,
        received.artifact.id,
        signature,
        registry.keys[0].id,
        await loadPackagePolicy(),
      ),
    );
    await rm(publicFile);
    await writeApplicationJson(path.join(output, "payload.json"), {
      schema_version: 1,
      source_commit: prepared.prepared_commit,
      run_id: current.run_id,
      producer_attempt: current.run_attempt,
      unsigned_artifact: received.artifact,
      payload: identity,
      signature: await applicationFileIdentity(path.join(output, `${name}.sig`)),
      inventory: await applicationFileIdentity(path.join(output, "updater-inventory.json")),
      controls,
      native,
      authority: "none",
    });
    await applicationOutput("attempt", current.run_attempt);
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
}

async function readNativePayloadAcceptance(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  packages: Awaited<ReturnType<typeof receiveApplicationPackages>>,
  provenance: "attested" | "raw" = "attested",
) {
  const current = execution();
  const { native_attempt: attempt, attestation_attempt: attestationAttempt } =
    inspectApplicationNativeAttempts(
      Number(process.env.PORTCOVE_NATIVE_ATTEMPT),
      provenance === "raw"
        ? current.run_attempt
        : Number(process.env.PORTCOVE_NATIVE_ATTESTATION_ATTEMPT),
      current.run_attempt,
    );
  const minimumPlatform = process.env.PORTCOVE_APPLICATION_NATIVE_MINIMUM_PLATFORM;
  assert.ok(
    minimumPlatform === "windows-11-26h2-x64" ||
      minimumPlatform === "windows-server-2022-x64-continuity",
    "selected native host scope is not appointed",
  );
  const hostInput = process.env.PORTCOVE_NATIVE_HOST ?? "";
  assert.ok(Buffer.byteLength(hostInput) > 0 && Buffer.byteLength(hostInput) <= 16384);
  const host = inspectApplicationNativeHost(JSON.parse(hostInput), minimumPlatform);
  const directory = path.resolve("work/application-native");
  await receiveApplicationData(directory, {
    id: Number(process.env.PORTCOVE_NATIVE_ARTIFACT),
    name:
      provenance === "raw"
        ? `application-native-capture-${current.run_id}-${attempt}`
        : `application-native-${current.run_id}-${attestationAttempt}`,
    source: current.source,
    run_id: current.run_id,
    files: applicationNativeFiles,
    maximum_file_bytes: 512 * 1024,
    maximum_archive_bytes: 1024 * 1024,
  });
  const subjects = await Promise.all(
    applicationNativeFiles.map(async (filename) => ({
      filename,
      sha256: sha256(await readFile(path.join(directory, filename))),
    })),
  );
  if (provenance === "attested")
    await verifyReleaseSourceAttestation(
      directory,
      applicationNativeFiles[0],
      {
        source_commit: current.source,
        ref: current.ref,
        run_id: current.run_id,
        run_attempt: attestationAttempt,
        subjects,
      },
      { scope: "application-native" },
    );
  assert.ok(
    isRecord(source.prepared) &&
      typeof source.prepared.prepared_commit === "string" &&
      typeof source.prepared.prepared_tree === "string" &&
      typeof source.prepared.version === "string",
  );
  const provider = await createReleaseCustodyProvider({
    token: readOnlyReleaseChildEnvironment()?.GH_TOKEN ?? "",
    deadline: performance.now() + (2 + 2 * nativeCompatibilitySourcePaths.length) * 30000,
    requestTimeoutMs: 30000,
    maxBytes: 8 * 1024 ** 2,
  });
  const commit = await provider.commit(current.source);
  assert.ok(
    isRecord(commit) &&
      commit.sha === current.source &&
      isRecord(commit.tree) &&
      typeof commit.tree.sha === "string",
  );
  const configuration = await provider.file(
    "apps/desktop/src-tauri/tauri.conf.json",
    source.prepared.prepared_commit,
  );
  assert.ok(
    isRecord(configuration) &&
      configuration.encoding === "base64" &&
      typeof configuration.content === "string" &&
      configuration.content.length <= 128 * 1024,
  );
  const bytes = Buffer.from(configuration.content, "base64");
  assert.ok(bytes.length > 0 && bytes.length <= 65536);
  const config: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.ok(
    isRecord(config) &&
      isRecord(config.bundle) &&
      isRecord(config.bundle.windows) &&
      typeof config.bundle.windows.minimumWebview2Version === "string",
  );
  const filename = `Portcove_${source.prepared.version}_x64-setup.exe`;
  const installer = packages.manifest.files.find((file) => file.filename === filename);
  assert.ok(installer);
  const productSource = source.prepared.prepared_commit;
  const declarations = await retainNativeSourceDeclarations(
    directory,
    (pathname) => provider.file(pathname, productSource),
    (sha) => provider.blob(sha),
  );
  const binding: ApplicationNativeBinding = {
    control_commit: current.source,
    control_tree: commit.tree.sha,
    control_ref: current.ref,
    harness_sha256: sha256(await readFile(applicationNativeHarness)),
    run_id: current.run_id,
    native_attempt: attempt,
    package_attempt: Number(process.env.PORTCOVE_PACKAGE_ATTEMPT),
    unsigned_artifact: Number(process.env.PORTCOVE_UNSIGNED_ARTIFACT),
    source_commit: source.prepared.prepared_commit,
    source_tree: source.prepared.prepared_tree,
    package: installer,
    package_manifest_sha256: sha256(
      await readFile("work/application-unsigned/application-release.json"),
    ),
    minimum_webview2_version: config.bundle.windows.minimumWebview2Version,
    minimum_platform: minimumPlatform,
    host,
    native_invocation_id: process.env.PORTCOVE_NATIVE_INVOCATION_ID ?? "",
    setup_plan_sha256: process.env.PORTCOVE_APPLICATION_SETUP_PLAN_SHA256 ?? "",
    source_declarations: declarations,
  };
  const accepted = inspectApplicationNativeAcceptance(
    await readApplicationJson(path.join(directory, applicationNativeFiles[0]), 65536),
    await readApplicationJson(path.join(directory, applicationNativeFiles[1]), 128 * 1024),
    await readApplicationJson(path.join(directory, applicationNativeFiles[2]), 512 * 1024),
    binding,
  );
  const producer = inspectApplicationNativeProducerJob(
    await readApplicationAttemptJobs(current.run_id, attempt),
    accepted.report,
    binding,
  );
  return {
    authority: "none",
    qualification: accepted.report,
    request_sha256: accepted.request_sha256,
    report_sha256: subjects.find((subject) => subject.filename === applicationNativeFiles[0])!
      .sha256,
    capture_sha256: accepted.capture_sha256,
    producer_attempt: attempt,
    attestation_attempt: provenance === "attested" ? attestationAttempt : null,
    producer_job_id: producer.job_id,
    native_host_scope: accepted.minimum_platform,
    artifact_id: Number(process.env.PORTCOVE_NATIVE_ARTIFACT),
    files: subjects,
    scope:
      "authenticated pre-sign native evidence at appointed host scope; post-sign/public installed acceptance remains separate",
  };
}

async function receiveSignedRoles(context: string, required: readonly string[]) {
  const current = execution();
  const raw: unknown = JSON.parse(process.env.PORTCOVE_SIGNED_ROLE_ARTIFACTS ?? "{}");
  assert.ok(isRecord(raw));
  assert.deepEqual(Object.keys(raw).sort(), [...required].sort());
  const output = path.resolve("work/application-signed-roles");
  await mkdir(output);
  for (const role of required) {
    assert.ok(onlineRoles.includes(role as (typeof onlineRoles)[number]));
    const binding: unknown = raw[role];
    assert.ok(
      isRecord(binding) &&
        Number.isSafeInteger(binding.attempt) &&
        Number(binding.attempt) >= 1 &&
        Number(binding.attempt) <= current.run_attempt,
    );
    const directory = path.resolve(`work/application-received-${role}`);
    await receiveApplicationData(directory, {
      id: Number(binding.id),
      name: `application-role-${role}-${current.run_id}-${Number(binding.attempt)}`,
      run_id: current.run_id,
      source: current.source,
      files: [`${role}.json`],
      maximum_file_bytes: 2 * 1024 ** 2,
      maximum_archive_bytes: 2 * 1024 ** 2,
    });
    await writeFile(
      path.join(output, `${role}.json`),
      await readFile(path.join(directory, `${role}.json`)),
      { flag: "wx" },
    );
  }
  assert.ok(path.isAbsolute(context));
  return output;
}

async function readForwardRenewalPreimage(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  scratch: string,
) {
  const basis = inspectApplicationRenewalSource(source);
  const parent = inspectApplicationReleaseReference(source.renewal_parent);
  const lineageDirectory = path.join(scratch, "pending-lineage");
  await mkdir(lineageDirectory);
  const lineage = await readApplicationPendingLineage(parent, lineageDirectory);
  const authority = lineage[0]!;
  assert.equal(authority.receipt.publication.repository_sha256, basis.repository_sha256);
  assert.ok(isRecord(source.run_custody));
  const custody = inspectApplicationRunCustody(source.run_custody.custody);
  assert.equal(custody.budget?.kind, "member");
  const owner = await readActualApplicationBudgetOwner({
    release_id: Number(source.run_custody.release_id),
    custody,
  });
  const original = await readActualApplicationBudgetOwner(authority);
  assert.equal(
    owner.release_id,
    original.release_id,
    "forward renewal changed its original cost owner",
  );
  const { discovered, prior } = await readApplicationPriorPublication(scratch, lineage);
  assert.equal(prior.receipt.site.generation, basis.site_generation);
  assert.equal(
    prior.receipt.publication.repository_sha256,
    source.renewal_public_prior_repository_sha256,
  );
  assertApplicationForwardPreimage(
    authority.metadata,
    authority.receipt.publication,
    prior.receipt.publication,
  );
  return { discovered, prior, lineage, authority };
}

async function materializePendingAuthority(
  authority: Awaited<ReturnType<typeof readApplicationPendingLineage>>[number],
  scratch: string,
) {
  const archive = authority.assets.find((asset) => asset.name === bootstrapAssetNames[0]);
  assert.ok(archive);
  const readAsset = createFixedApplicationReleaseAssetReader(scratch);
  const bytes = await readAsset(archive.id, archive.bytes);
  assert.equal(bytes.length, archive.bytes);
  assert.equal(sha256(bytes), archive.sha256);
  const decoded = readBootstrapSiteArchive(bytes, authority.receipt);
  const directory = path.join(scratch, "pending-authority-repository");
  await mkdir(directory);
  for (const [name, value] of decoded.files) {
    if (!name.startsWith("application/")) continue;
    const destination = path.join(directory, name.slice("application/".length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, value, { flag: "wx", mode: 0o600 });
  }
  return { directory };
}

async function prepareApplicationPrior(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  scratch: string,
) {
  const forward =
    source.renewal_parent === undefined
      ? undefined
      : await readForwardRenewalPreimage(source, scratch);
  const { discovered, prior } =
    forward ??
    (await readApplicationPriorPublication(
      scratch,
      undefined,
      source.purpose === "metadata-renewal" ? "renew-served-metadata" : undefined,
    ));
  const priorRepository =
    forward?.authority.receipt.publication.repository_sha256 ??
    prior.receipt.publication.repository_sha256;
  assert.ok(typeof priorRepository === "string");
  if (source.purpose === "metadata-renewal") {
    const basis = inspectApplicationRenewalSource(source);
    assert.equal(priorRepository, basis.repository_sha256);
    assert.equal(prior.receipt.site.generation, basis.site_generation);
  }
  const component = forward
    ? await materializePendingAuthority(forward.authority, scratch)
    : await materializePublishedApplicationComponent(
        {
          site_generation_sha256: prior.receipt.site.generation,
          root_sha256: applicationReleaseTrust.root.sha256,
          repository_sha256: priorRepository,
        },
        scratch,
      );
  assert.ok(isRecord(source.run_custody));
  const custody = inspectApplicationRunCustody(source.run_custody.custody);
  const plan = await readApplicationMetadataContextPlan(
    await createApplicationRunRegistrationProvider(),
    { release_id: Number(source.run_custody.release_id), custody },
    execution(),
  );
  const generatedAt = plan.generated_at;
  if (source.purpose === "metadata-renewal")
    assert.equal(source.renewal_clock, "native-context-reservation-v1");
  const priorFacts = forward?.authority.receipt.publication ?? prior.receipt.publication;
  const historical =
    source.purpose === "metadata-renewal" &&
    Object.entries(priorFacts.expires).some(
      ([role, value]) => role !== "targets" && Date.parse(value) <= Date.now(),
    );
  const verifier = path.join(toolDirectory, "portcove-release-tools");
  const renewalOutput = path.join(scratch, "renewal-output");
  await mkdir(renewalOutput);
  const prepared = await prepareAuthenticatedMetadataRenewal({
    initial_root_profile: "single-owner-one-of-one-v1",
    verifier,
    verifier_sha256: (await applicationFileIdentity(verifier)).sha256,
    trusted_root: path.resolve(applicationReleaseTrust.root.path),
    trusted_root_sha256: applicationReleaseTrust.root.sha256,
    ...(historical ? { prior_expiration_policy: "historical-online-expired-v1" as const } : {}),
    ...(plan.previous_reserved_versions
      ? { previous_reserved_versions: plan.previous_reserved_versions }
      : {}),
    previous_repository: component.directory,
    prior_repository_sha256: priorRepository,
    generated_at: generatedAt,
    output_parent: renewalOutput,
  });
  assert.deepEqual(
    await discoverActualPublishedApplicationCohort(forward?.lineage),
    discovered,
    "prior cohort changed during actual authentication",
  );
  if (forward) {
    const actual = await inspectPreparedMetadataRenewal(prepared);
    assert.deepEqual(
      actual.descriptor.current_versions,
      forward.authority.receipt.publication.versions,
    );
    assert.deepEqual(
      actual.descriptor.current_expires,
      forward.authority.receipt.publication.expires,
    );
    assert.equal(
      actual.descriptor.unchanged_records_sha256,
      forward.authority.receipt.publication.records_sha256,
    );
  }
  return prepared;
}

async function verifyApplicationPayloadSignature(
  version: string,
  installer: { filename: string; sha256: string; bytes: number },
  packageDirectory: string,
  signatureDirectory: string,
  scratch: string,
) {
  const name = `Portcove_${version}_x64-setup.exe`;
  assert.equal(installer.filename, name);
  const registry = await readApplicationJson(applicationReleaseTrust.payload.path);
  assert.ok(
    isRecord(registry) &&
      Array.isArray(registry.keys) &&
      registry.keys.length === 1 &&
      isRecord(registry.keys[0]) &&
      typeof registry.keys[0].tauri_public_key === "string",
  );
  const publicFile = path.join(scratch, "payload.pub");
  await writeFile(publicFile, registry.keys[0].tauri_public_key, { flag: "wx", mode: 0o600 });
  execFileSync(
    path.join(toolDirectory, "portcove-release-tools"),
    [
      "verify",
      path.join(packageDirectory, name),
      path.join(signatureDirectory, `${name}.sig`),
      publicFile,
      installer.sha256,
      String(installer.bytes),
    ],
    { env: payloadSigningEnvironment(scratch), timeout: 120000, maxBuffer: 65536, stdio: "pipe" },
  );
  const signature = await readFile(path.join(signatureDirectory, `${name}.sig`));
  const comment = Buffer.from(signature.toString("utf8").trim(), "base64")
    .toString("utf8")
    .trim()
    .split(/\r?\n/u)[2];
  assert.ok(
    comment?.startsWith("trusted comment: timestamp:") &&
      comment.endsWith(`\tfile:${name}\tversion:${version}`),
  );
  return signature;
}

async function receiveApplicationSignedPayload(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  packages: Awaited<ReturnType<typeof receiveNativePackages>>,
  scratch: string,
) {
  const current = execution();
  assert.ok(isRecord(source.prepared) && typeof source.prepared.version === "string");
  const name = `Portcove_${source.prepared.version}_x64-setup.exe`;
  const attempt = Number(process.env.PORTCOVE_SIGNATURE_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const signatureDirectory = path.resolve("work/application-received-signature");
  await receiveApplicationData(signatureDirectory, {
    id: Number(process.env.PORTCOVE_SIGNATURE_ARTIFACT),
    name: `application-signature-${current.run_id}-${attempt}`,
    run_id: current.run_id,
    source: current.source,
    files: [`${name}.sig`, "updater-inventory.json", "payload.json"],
    maximum_file_bytes: 1024 * 1024,
    maximum_archive_bytes: 2 * 1024 ** 2,
  });
  const installer = packages.manifest.files.find((file) => file.filename === name);
  assert.ok(installer);
  const signature = await verifyApplicationPayloadSignature(
    source.prepared.version,
    installer,
    path.resolve("work/application-unsigned"),
    signatureDirectory,
    scratch,
  );
  return {
    signature,
    inventory: await readFile(path.join(signatureDirectory, "updater-inventory.json")),
    directory: signatureDirectory,
    filename: `${name}.sig`,
  };
}

function applicationSourceQualification(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
) {
  assert.ok(isRecord(source.run_custody));
  const custody = inspectApplicationRunCustody(source.run_custody.custody);
  const qualified = inspectApplicationQualificationIdentity(source.qualification, custody.source);
  assert.deepEqual(
    qualified,
    custody.preparation?.qualification,
    "source qualification differs from the original preparation custody",
  );
  return qualified;
}

function applicationRecordInput(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  packages: Awaited<ReturnType<typeof receiveNativePackages>>,
  native: Awaited<ReturnType<typeof readNativePayloadAcceptance>>,
  signedPayload: Awaited<ReturnType<typeof receiveApplicationSignedPayload>>,
) {
  assert.ok(isRecord(source.semantic) && isRecord(source.semantic.opportunity));
  return {
    manifest: packages.manifest,
    unsigned_artifact: packages.artifact.id,
    native_report: native.qualification,
    inventory: signedPayload.inventory,
    signature: signedPayload.signature,
    classification: source.semantic.opportunity.classification,
    qualification: applicationSourceQualification(source),
    evidence_ids: [
      `native-report:${native.report_sha256}`,
      `native-capture:${native.capture_sha256}`,
      `native-job:${native.producer_job_id}`,
    ],
  };
}

async function prepareContext() {
  const current = execution();
  const source = await readNativeApplicationSource();
  await guard(source, false);
  const context = path.resolve("work/application-context-produced");
  const scratch = path.join(process.env.RUNNER_TEMP ?? "", "application-context-inspection");
  assert.ok(path.isAbsolute(scratch));
  await mkdir(scratch);
  if (source.purpose === "metadata-bootstrap") {
    const expected = bootstrapAppointment();
    assert.equal(source.opportunity, expected.descriptor_sha256);
    assert.deepEqual(source.bootstrap_appointment, expected);
    await prepareInitialApplicationContext(context, source.bootstrap_descriptor, expected);
  } else if (source.purpose === "metadata-renewal") {
    assert.equal(source.execution_path, "metadata-maintenance");
    const prior = await prepareApplicationPrior(source, scratch);
    await prepareApplicationMetadataRenewalContext(context, prior, source);
    await guard(source, false);
  } else {
    assert.equal(source.purpose, "application-release");
    const prior = await prepareApplicationPrior(source, scratch);
    const packages = await receiveNativePackages(source);
    const native = await readNativePayloadAcceptance(source, packages);
    const signedPayload = await receiveApplicationSignedPayload(source, packages, scratch);
    await prepareApplicationReleaseContext(
      context,
      prior,
      applicationRecordInput(source, packages, native, signedPayload),
    );
    await guard(source, false);
  }
  const inspected = inspectApplicationContextBeforeKey(
    context,
    path.join(toolDirectory, "portcove-release-tools"),
    scratch,
  );
  if (source.purpose !== "application-release") {
    if (source.purpose === "metadata-bootstrap") assert.equal(inspected.records, 0);
    assert.equal(inspected.records_unchanged, true);
  } else
    assert.ok(
      typeof inspected.records === "number" &&
        inspected.records > 0 &&
        inspected.records_unchanged === false,
    );
  let handoff: ApplicationContextReservationHandoff | undefined;
  if (source.purpose !== "metadata-bootstrap") {
    assert.ok(isRecord(source.run_custody));
    const identity = applicationMetadataContextIdentity(
      await readBoundedReleaseContextFiles(context),
    );
    const retained = await retainApplicationMetadataContext(
      await createApplicationRunRegistrationProvider(),
      {
        release_id: Number(source.run_custody.release_id),
        custody: inspectApplicationRunCustody(source.run_custody.custody),
      },
      current,
      {
        ...identity,
        opportunity: String(source.opportunity),
        run_id: current.run_id,
        run_attempt: current.run_attempt,
        control_commit: current.source,
        control_ref: current.ref,
      },
      async () => {
        await guard(source, false);
      },
    );
    const reservation = retained.custody.metadata_contexts?.at(-1);
    assert.ok(reservation);
    handoff = { owner_release_id: retained.release_id, reservation };
    await guard(source, false);
  }
  await packApplicationContext(
    context,
    "work/application-context-output/context-bundle.json",
    handoff,
  );
  await applicationOutput("attempt", current.run_attempt);
}

async function assertReservedApplicationContext(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  context: Awaited<ReturnType<typeof receiveApplicationContext>>,
  custody: "live" | "verified-context",
) {
  if (source.purpose === "metadata-bootstrap") {
    assert.equal(context.custody, undefined);
    return;
  }
  const current = execution(),
    attempt = Number(process.env.PORTCOVE_CONTEXT_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  assert.ok(isRecord(source.run_custody));
  const owner = {
    release_id: Number(source.run_custody.release_id),
    custody: inspectApplicationRunCustody(source.run_custody.custody),
  };
  const producer = { ...current, run_attempt: attempt };
  const reservation = assertApplicationContextReservationHandoff(
    context.custody,
    await readBoundedReleaseContextFiles(context.directory),
    owner,
    producer,
  );
  if (custody === "verified-context" && owner.custody.budget?.kind !== "member") return;
  const plan = await readApplicationMetadataContextPlan(
    await createApplicationRunRegistrationProvider(),
    owner,
    producer,
  );
  assert.ok(plan.existing, "context producer has no retained native metadata reservation");
  assert.deepEqual(
    reservation,
    plan.existing,
    "context differs from the live producer reservation",
  );
}

let signingStage = "source";

async function signMetadata(role: (typeof onlineRoles)[number]) {
  const current = execution();
  const source = await readNativeApplicationSource();
  if (source.purpose === "metadata-renewal")
    assert.equal(source.execution_path, "metadata-maintenance");
  signingStage = "context";
  const receivedContext = await receiveApplicationContext();
  const context = receivedContext.directory;
  signingStage = "reservation";
  await assertReservedApplicationContext(source, receivedContext, "verified-context");
  const configuration = await readApplicationJson(path.join(context, "context.json"), 65536);
  assert.ok(isRecord(configuration));
  const onlineTargets = configuration.top_level_targets_profile === "online-unchanged-authority-v1";
  if (role === "targets" && !onlineTargets) {
    await applicationOutput("changed", false);
    return;
  }
  const dependencies = ["releases", "preview", "stable", ...(onlineTargets ? ["targets"] : [])];
  signingStage = "role-dependencies";
  const signed =
    role === "snapshot" || role === "timestamp"
      ? await receiveSignedRoles(context, [
          ...dependencies,
          ...(role === "timestamp" ? ["snapshot"] : []),
        ])
      : null;
  signingStage = "context-inspection";
  const scratch = path.join(process.env.RUNNER_TEMP ?? "", `application-${role}-key`);
  assert.ok(path.isAbsolute(scratch));
  await mkdir(scratch, { mode: 0o700 });
  const tool = path.join(toolDirectory, "portcove-release-tools");
  if (source.purpose === "metadata-bootstrap")
    inspectInitialApplicationDescriptor(
      await readApplicationJson(path.join(context, "initial-bootstrap.json")),
      bootstrapAppointment(),
    );
  const inspected = inspectApplicationContextBeforeKey(context, tool, scratch);
  if (source.purpose === "metadata-renewal")
    assertApplicationRenewalContext(await readBoundedReleaseContextFiles(context), source);
  if (source.purpose !== "application-release") {
    assert.equal(
      inspected.records_unchanged,
      true,
      "metadata-only authority cannot add or alter application records",
    );
    if (source.purpose === "metadata-bootstrap") assert.equal(inspected.records, 0);
  }
  // The fixed role environment admits the immutable controller tag.
  // Served renewal signs unchanged records into a private attempt artifact.
  // Publication and Pages still require fresh independent protection receipts.
  const servedRenewal = process.env.PORTCOVE_PROTECTION_PHASE === "served-renewal";
  if (servedRenewal) {
    assert.equal(source.purpose, "metadata-renewal");
    assert.equal(source.execution_path, "metadata-maintenance");
    assert.equal(source.renewal_parent, undefined);
    assert.equal(current.ref, retainedV8ServedRenewal.next_ref);
    assert.ok(role !== "targets");
    assert.equal(process.env.PORTCOVE_PROTECTION_ARTIFACT ?? "", "");
    assert.ok(inspected.records_unchanged);
  }
  signingStage = "release-guard";
  await guard(source, !servedRenewal, {
    useVerifiedSourceCustody: true,
    markStage(next) {
      signingStage = next;
    },
  });
  signingStage = "reservation-recheck";
  await assertReservedApplicationContext(source, receivedContext, "verified-context");
  if (!servedRenewal) assertProtectionWriteWindow();
  signingStage = "isolated-signing";
  const output = path.resolve(`work/application-role-${role}`);
  await mkdir(output);
  const keyFile = path.join(scratch, "role.key");
  const config = path.join(scratch, "sign.json");
  try {
    const raw = process.env.PORTCOVE_SIGNING_KEY;
    assert.ok(typeof raw === "string");
    const key = decodeTufRoleKey(raw);
    await writeFile(keyFile, key, { flag: "wx", mode: 0o600 });
    key.fill(0);
    await writeApplicationJson(config, {
      schema_version: 1,
      context: path.join(context, "context.json"),
      signing_key: keyFile,
      output: path.join(output, `${role}.json`),
      ...(signed ? { signed_roles: signed } : {}),
    });
    execFileSync(tool, ["sign-tuf-role", role, config], {
      env: payloadSigningEnvironment(scratch),
      timeout: 90000,
      maxBuffer: 65536,
      stdio: "pipe",
    });
    await applicationOutput("attempt", current.run_attempt);
    await applicationOutput("changed", true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

let assemblyStage = "source";
let publicationStage = "source";
let publicationProtectionObservedAt: string | undefined;

async function assembleMetadata() {
  assemblyStage = "source";
  const source = await readNativeApplicationSource();
  if (source.purpose === "metadata-renewal")
    assert.equal(source.execution_path, "metadata-maintenance");
  assemblyStage = "context";
  const receivedContext = await receiveApplicationContext();
  const context = receivedContext.directory;
  assemblyStage = "reservation";
  await assertReservedApplicationContext(source, receivedContext, "verified-context");
  const configuration = await readApplicationJson(path.join(context, "context.json"), 65536);
  assert.ok(isRecord(configuration));
  if (source.purpose === "metadata-renewal")
    assertApplicationRenewalContext(await readBoundedReleaseContextFiles(context), source);
  assemblyStage = "signed-roles";
  const signed = await receiveSignedRoles(context, [
    "releases",
    "preview",
    "stable",
    "snapshot",
    "timestamp",
    ...(configuration.top_level_targets_profile === "online-unchanged-authority-v1"
      ? ["targets"]
      : []),
  ]);
  assemblyStage = "release-guard";
  await guard(source, false, {
    useVerifiedSourceCustody: true,
    markStage(next) {
      assemblyStage = next;
    },
  });
  assemblyStage = "native-assembly";
  const scratch = path.join(process.env.RUNNER_TEMP ?? "", "application-assembly");
  await mkdir(scratch);
  const env = await preparePayloadSigningEnvironment(scratch);
  const config = path.join(scratch, "assemble.json");
  await writeApplicationJson(config, {
    schema_version: 1,
    context: path.join(context, "context.json"),
    signed_roles: signed,
    output: path.resolve("work/application-repository"),
  });
  const report = execFileSync(
    path.join(toolDirectory, "portcove-release-tools"),
    ["assemble-tuf", config],
    {
      env,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
    },
  );
  const raw: unknown = JSON.parse(report.toString("utf8"));
  assert.ok(isRecord(raw));
  await writeApplicationJson("work/application-assembly/assembly.json", raw);
  if (source.purpose === "metadata-bootstrap") {
    assemblyStage = "publication-contract";
    const descriptor = assertMetadataBootstrapPublication(
      await readApplicationJson(path.join(context, "initial-bootstrap.json")),
      raw.publication,
    );
    const appointedPreimage = process.env.PORTCOVE_APPLICATION_INITIAL_SITE_PREIMAGE_SHA256;
    assert.ok(
      typeof appointedPreimage === "string" && /^[a-f0-9]{64}$/u.test(appointedPreimage),
      "initial whole-site preimage appointment is missing",
    );
    assert.equal(
      descriptor.initial_site_preimage_sha256,
      appointedPreimage,
      "initial whole-site preimage requires its separate setup appointment",
    );
    assemblyStage = "site-preimage";
    const retained = await materializeInitialApplicationRehearsal(
      await readApplicationJson(
        "release/bootstrap-public-inputs/application/initial-site-preimage.json",
      ),
      descriptor.initial_site_preimage_sha256,
      scratch,
    );
    const output = path.resolve("work/application-site");
    await mkdir(output);
    assemblyStage = "site-composition";
    const site = await composeSiteFiles({
      previous: null,
      expected_previous_generation: null,
      application: path.resolve("work/application-repository"),
      application_root_sha256: applicationReleaseTrust.root.sha256,
      initial_rehearsal: retained,
      output_parent: output,
    });
    await writeApplicationJson("work/application-assembly/site.json", {
      schema_version: 1,
      authority: "none",
      generation: site.generation,
      retained_inventory_sha256: retained.inventory_sha256,
      scope: "assembled initial application feed and exact retained rehearsal bytes; no deployment",
    });
    await applicationOutput("site_directory", site.output);
  } else {
    assert.ok(source.purpose === "application-release" || source.purpose === "metadata-renewal");
    const forward =
      source.renewal_parent === undefined
        ? undefined
        : await readForwardRenewalPreimage(source, scratch);
    const { discovered, prior } =
      forward ??
      (await readApplicationPriorPublication(
        scratch,
        undefined,
        source.purpose === "metadata-renewal" ? "renew-served-metadata" : undefined,
      ));
    const priorRepository = prior.receipt.publication.repository_sha256;
    assert.ok(typeof priorRepository === "string");
    if (source.purpose === "metadata-renewal") {
      const basis = inspectApplicationRenewalSource(source);
      assert.equal(
        forward?.authority.receipt.publication.repository_sha256 ?? priorRepository,
        basis.repository_sha256,
      );
      assert.equal(prior.receipt.site.generation, basis.site_generation);
      assertMetadataRenewalPublication(
        await readApplicationJson(path.join(context, "renewal.json")),
        raw.publication,
      );
    }
    assert.equal(
      applicationContextPriorRepositorySha256(await readBoundedReleaseContextFiles(context)),
      forward?.authority.receipt.publication.repository_sha256 ?? priorRepository,
      "current public metadata differs from the exact signed context prior",
    );
    const previous = await materializePublishedCompleteSite(
      {
        site_generation_sha256: prior.receipt.site.generation,
        root_sha256: applicationReleaseTrust.root.sha256,
        repository_sha256: priorRepository,
      },
      scratch,
    );
    const output = path.resolve("work/application-site");
    await mkdir(output);
    const site = await composeSiteFiles({
      previous: previous.directory,
      expected_previous_generation: prior.receipt.site.generation,
      application: path.resolve("work/application-repository"),
      application_root_sha256: applicationReleaseTrust.root.sha256,
      output_parent: output,
    });
    assert.deepEqual(
      await discoverActualPublishedApplicationCohort(forward?.lineage),
      discovered,
      "prior cohort changed during actual site assembly",
    );
    await guard(source, false, { useVerifiedSourceCustody: true });
    await writeApplicationJson("work/application-assembly/site.json", {
      schema_version: 1,
      authority: "none",
      generation: site.generation,
      retained_inventory_sha256: releaseCanonicalDigest(
        site.generation.files.filter((file) => !file.path.startsWith("application/")),
      ),
      prior_generation: prior.receipt.site.generation,
      prior_repository_sha256: priorRepository,
      ...(forward
        ? { authority_repository_sha256: forward.authority.receipt.publication.repository_sha256 }
        : {}),
      context_sha256: sha256(await readFile(path.join(context, "context.json"))),
      scope:
        "actual authenticated assembly and exact current public prior/retained bytes; no publication or deployment",
    });
    await applicationOutput("site_directory", site.output);
  }
}

async function main() {
  assert.ok(process.env.RUNNER_TEMP);
  const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP, "application-private-reads-"));
  await withReadOnlyReleaseChildren(directory, async () => {
    if (process.argv[2] === "observe") await observe();
    else if (process.argv[2] === "native-attest") await attestNative();
    else if (process.argv[2] === "payload") await payload();
    else if (process.argv[2] === "assemble") await assembleMetadata();
    else if (process.argv[2] === "stage-site") await stageBootstrapSite();
    else if (process.argv[2] === "draft-recovery-stage") await stageDraftRecovery();
    else if (process.argv[2] === "draft-recovery-retain") await retainDraftRecoveryBackup();
    else if (process.argv[2] === "publication-prepare") {
      const source = await readNativeApplicationSource();
      if (source.purpose === "application-release") await prepareOrdinaryPublication(source);
      else await publishMetadataRelease("prepare", source);
    } else if (process.argv[2] === "publication") {
      const source = await readNativeApplicationSource();
      if (source.purpose === "application-release") await publishOrdinaryMetadata(source);
      else await publishMetadataRelease("publish", source);
    } else if (process.argv[2] === "prepare-feed") {
      const source = await readNativeApplicationSource();
      if (source.purpose === "application-release") await prepareOrdinaryFeed(source);
      else await prepareBootstrapFeed();
    } else if (process.argv[2] === "capture-pages") await captureBootstrapPagesArchive();
    else if (process.argv[2] === "site-preflight") await preflightBootstrapSite();
    else if (process.argv[2] === "feed") await deployBootstrapSite();
    else if (process.argv[2] === "site-readback") await deployBootstrapSite(true);
    else if (process.argv[2] === "windows-candidate")
      await preparePublicWindowsCandidate(await readNativeApplicationSource());
    else if (process.argv[2] === "windows-proof") await verifyPublicWindowsInstalled();
    else if (process.argv[2] === "context") await prepareContext();
    else if (process.argv[2]?.startsWith("role-")) {
      const role = process.argv[2].slice(5);
      assert.ok(onlineRoles.includes(role as (typeof onlineRoles)[number]));
      await signMetadata(role as (typeof onlineRoles)[number]);
    } else throw new Error("unknown fixed private role operation");
  });
}

export { guard as guardApplicationReleaseSource };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    if (onlineRoles.some((role) => process.argv[2] === `role-${role}`)) {
      const age =
        publicationProtectionObservedAt === undefined
          ? NaN
          : Date.now() - Date.parse(publicationProtectionObservedAt);
      const observation =
        Number.isSafeInteger(age) && age >= 0 ? ` (observation age ${age} ms)` : "";
      console.error(`Application metadata signing refused at ${signingStage}${observation}.`);
    }
    if (
      ["assemble", "publication", "publication-prepare", "feed", "site-readback"].includes(
        process.argv[2] ?? "",
      )
    ) {
      const status =
        error instanceof GitHubApiError &&
        Number.isInteger(error.status) &&
        Number(error.status) >= 400 &&
        Number(error.status) <= 599
          ? ` (HTTP ${error.status})`
          : "";
      const assembling = process.argv[2] === "assemble";
      const role =
        process.argv[2] === "feed" || process.argv[2] === "site-readback"
          ? process.argv[2]
          : assembling
            ? "assembly"
            : "publication";
      const age =
        publicationProtectionObservedAt === undefined
          ? NaN
          : Date.now() - Date.parse(publicationProtectionObservedAt);
      const observation =
        !assembling && Number.isSafeInteger(age) && age >= 0 ? ` (observation age ${age} ms)` : "";
      console.error(
        `Application ${role} refused at ${assembling ? assemblyStage : publicationStage}${status}${observation}.`,
      );
    }
    console.error("Fixed application role failed; private subprocess output is not retained.");
    process.exitCode = 1;
  }
}
