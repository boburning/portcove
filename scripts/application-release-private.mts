/** Fixed trusted role commands, bundled on a separate secret-free runner.
 * Candidate packages remain data here. Only native acceptance jobs launch them. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import {
  applicationApi,
  applicationGet,
  applicationOutput,
  readApplicationJson,
  applicationGh,
  receiveApplicationData,
  writeApplicationJson,
  sha256,
  applicationFileIdentity,
} from "./application-release-io.mts";
import {
  applicationReleaseTrust,
  inspectApplicationSpendingAppointment,
  inspectApplicationReleaseExecution,
  verifyApplicationReleaseTrust,
} from "./application-release-policy.mts";
import { readApplicationJobBudget } from "./application-release-budget.mts";
import { readPublicationPause } from "./release-control-inputs.mts";
import { semanticReviewCheckName } from "./release-control-phases.mts";
import {
  readIndependentSemanticCheckInventory,
  selectLatestApplicationSemanticCheck,
} from "./release-semantic-disposition-reader.mts";
import {
  observeReleaseInputProtections,
  requireReleaseImmutabilityPolicy,
} from "./release-input-protections.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import { receiveApplicationPackages } from "./application-release-transfer.mts";
import { createApplicationUpdaterInventory } from "./application-release-artifacts.mts";
import { loadPackagePolicy } from "./release-package-policy.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import {
  receiveApplicationContext,
  inspectApplicationContextBeforeKey,
  prepareInitialApplicationContext,
  packApplicationContext,
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
import { readGitHubReleaseAsset, readGitHubArtifactArchive } from "./github-binary.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import {
  readImmutableBootstrapFeed,
  readImmutableApplicationMetadataFeed,
  verifyBootstrapPagesArtifact,
  discoverPublishedApplicationCohort,
  readApplicationPriorPublication,
  readApplicationPendingLineage,
  assertApplicationForwardPreimage,
} from "./application-release-feed.mts";
import { projectWindowsNsisExecutable } from "./release-compiler-desktop.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  readApplicationPagesState,
  assertBootstrapPagesActor,
  executeBootstrapPages,
} from "./application-release-site.mts";
import { inspectSiteGeneration } from "./release-site-generation.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import {
  applicationNativeHarness,
  applicationNativeFiles,
  inspectApplicationNativeAcceptance,
  inspectApplicationNativeProducerJob,
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
  verifyApplicationDraftRecoveryBackup,
  readStagedDraftRecoveryBackup,
  removeExpiredApplicationDraftAssets,
  inspectHistoricalApplicationPublication,
  prepareApplicationReleaseDraft,
  publishPreparedApplicationRelease,
  readImmutableApplicationRelease,
  inspectApplicationReleaseAttestation,
  readBootstrapSiteArchive,
  inspectApplicationMetadataPublicationReceipt,
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
  readRegisteredApplicationRuns,
  inspectApplicationReleaseReference,
  readApplicationBudgetOwner,
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
    maximum_file_bytes: 1024 * 1024,
    maximum_archive_bytes: 1024 * 1024,
  });
  const source = await readApplicationJson(path.join(directory, "source.json"));
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

function assertCurrentApplicationSemantic(original: string, semantic: unknown) {
  const producer = {
    schema_version: 2,
    purpose: "application",
    review_app_id: 5555053,
    review_check_name: semanticReviewCheckName,
  };
  const records = readIndependentSemanticCheckInventory(applicationApi, producer, original);
  const latest = selectLatestApplicationSemanticCheck(records.records);
  assert.ok(latest && isRecord(semantic));
  assert.equal(latest.id, semantic.check_id);
  assert.equal(latest.status, "completed");
  assert.equal(latest.conclusion, "success");
  assert.ok(isRecord(latest.output) && typeof latest.output.summary === "string");
  assert.equal(sha256(Buffer.from(latest.output.summary)), semantic.summary_sha256);
  records.assertUnchanged();
}

async function guard(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  protection = true,
) {
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
  const spending = inspectApplicationSpendingAppointment(process.env);
  const pause = readPublicationPause(applicationApi);
  assert.equal(pause.publication_paused, false, "publication paused");
  if (source.purpose === "application-release") {
    assert.ok(typeof source.original_source === "string");
    assertCurrentApplicationSemantic(source.original_source, source.semantic);
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
        "snapshot",
        "timestamp",
        "draft-recovery",
        "publication",
        "feed",
      ].includes(phase),
    );
    const directory = path.resolve("work/application-protection");
    const identity = JSON.stringify([
      process.env.PORTCOVE_PROTECTION_ARTIFACT,
      phase,
      current.source,
      current.run_id,
      attempt,
    ]);
    if (receivedProtection !== undefined) assert.equal(receivedProtection, identity);
    else {
      await receiveApplicationData(directory, {
        id: Number(process.env.PORTCOVE_PROTECTION_ARTIFACT),
        name: `application-protection-${phase}-${current.run_id}-${attempt}`,
        source: current.source,
        run_id: current.run_id,
        files: ["protection.json"],
        maximum_file_bytes: 2 * 1024 ** 2,
        maximum_archive_bytes: 2 * 1024 ** 2,
      });
      receivedProtection = identity;
    }
    // Reuse only the authenticated provider input, never its freshness result.
    // Every guard below rereads it and checks the original 60-second deadline.
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
    assertProtectionWriteWindow = () => {
      const observation = requireReleaseImmutabilityPolicy(receipt.observation);
      assert.equal(observation.inventory_sha256, expectedDigest);
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
  const registered = readRegisteredApplicationRuns(
    applicationApi,
    Number(source.run_custody.release_id),
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
    const owner = readApplicationBudgetOwner(applicationApi, {
      release_id: Number(source.run_custody.release_id),
      custody: registered,
    });
    if (owner.custody.preparation)
      assertCurrentApplicationSemantic(owner.custody.source, source.renewal_semantic);
  }
  const known = registered.runs.map((run) => run.id);
  assert.deepEqual(JSON.parse(process.env.PORTCOVE_KNOWN_RELEASE_RUNS ?? "null"), known);
  const budget = readApplicationJobBudget(
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

async function stageBootstrapSite() {
  // This is the same key-free assembly job, after standard artifact upload.
  const source = await readApplicationJson(path.join(sourceDirectory, "source.json"));
  assert.ok(isRecord(source));
  await guard(source, false);
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
  const archive = await receiveApplicationData(path.resolve("work/application-site-verified"), {
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
  const archiveBytes = await readFile(path.join(destination, bootstrapAssetNames[0]));
  inspectBootstrapSiteArchive(archiveBytes, inspected);
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
) {
  const current = execution();
  const attempt = Number(process.env.PORTCOVE_PUBLICATION_INPUT_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  await receiveApplicationData(directory, {
    id: Number(process.env.PORTCOVE_PUBLICATION_INPUT_ARTIFACT),
    name: `application-publication-input-${current.run_id}-${attempt}`,
    source: current.source,
    run_id: current.run_id,
    files: bootstrapAssetNames,
  });
  const subjects = await Promise.all(
    bootstrapAssetNames.map(async (name) => {
      const file = await applicationFileIdentity(path.join(directory, name));
      return { filename: name, sha256: file.sha256 };
    }),
  );
  await verifyReleaseSourceAttestation(
    directory,
    bootstrapAssetNames[1],
    {
      source_commit: current.source,
      ref: current.ref,
      run_id: current.run_id,
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
  const inspect = () => readApplicationDraftRecoveryState(applicationApi, expected);
  const initial = inspect();
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
    assert.deepEqual(inspect(), initial, "draft changed before retaining replacement");
  };
  const owner = await retainApplicationDraftAssembly(
    applicationApi,
    expected,
    current,
    replacement,
    before,
  );
  const retained = inspect();
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
    assert.deepEqual(inspect(), retained, "draft changed during backup reuse");
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
      async readAsset(id, maximum) {
        return readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${id}`, {
          cwd: process.cwd(),
          maxBytes: maximum,
          timeoutMs: 30000,
        });
      },
      authenticateAssembly: authenticateDraftRecoveryAssembly,
    },
  );
  assert.deepEqual(inspect(), retained, "draft changed during backup preparation");
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
  const inspect = () => readApplicationDraftRecoveryState(applicationApi, expected);
  const draft = inspect();
  assert.ok(draft);
  assert.equal(releaseCanonicalDigest(draft), process.env.PORTCOVE_DRAFT_BACKUP_DRAFT_SHA256);
  const { owner } = readApplicationMetadataContextPlan(applicationApi, expected, current);
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
  await retainApplicationDraftRecovery(applicationApi, expected, current, recovery, async () => {
    await guard(source, false);
    assert.deepEqual(
      readApplicationMetadataContextPlan(applicationApi, expected, current).owner,
      owner,
      "recovery owner changed during backup readback",
    );
    assert.deepEqual(inspect(), draft, "draft changed during backup readback");
  });
}

async function verifyRetainedDraftRecovery(
  expected: Parameters<typeof readApplicationDraftRecoveryState>[1],
  owner: ReturnType<typeof readApplicationMetadataContextPlan>["owner"],
  replacement: ReturnType<typeof applicationDraftAssembly>,
  metadata: Buffer,
  initial: NonNullable<ReturnType<typeof readApplicationDraftRecoveryState>>,
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
  beforeWrite: () => Promise<() => void>,
) {
  const current = execution();
  const inspect = () => readApplicationDraftRecoveryState(applicationApi, expected);
  const initial = inspect();
  if (!initial) return;
  const replacement = applicationDraftAssembly(expected.release_id, raw, publication, files);
  const { owner } = readApplicationMetadataContextPlan(applicationApi, expected, current);
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
  assert.deepEqual(inspect(), initial, "draft changed while authenticating recovery backup");
  await removeExpiredApplicationDraftAssets(recovery, old, replacement, {
    api: applicationApi,
    inspectDraft() {
      const draft = inspect();
      assert.ok(draft && draft.direct === initial.direct);
      return draft;
    },
    claim(assetId, beforeClaim) {
      return claimApplicationDraftAssetRemoval(
        applicationApi,
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

async function uploadApplicationReleaseAsset(releaseId: number, name: string, bytes: Buffer) {
  assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u);
  const token = process.env.GH_TOKEN;
  assert.ok(token && token.length <= 16384 && !/[\r\n\0]/u.test(token));
  const response = await fetch(
    `https://uploads.github.com/repos/boburning/portcove/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": name.endsWith(".zip")
          ? "application/zip"
          : name.endsWith(".json")
            ? "application/json"
            : "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: new Uint8Array(bytes),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  await response.body?.cancel();
  assert.equal(response.status, 201);
}

async function prepareOrdinaryPublication() {
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  const current = execution(),
    source = await readNativeApplicationSource();
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
  const context = await receiveApplicationContext();
  await assertReservedApplicationContext(source, context);
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
    readApplicationPagesState(applicationApi),
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
    assert.deepEqual(discoverPublishedApplicationCohort(applicationApi), discovered);
    await guard(source);
    return () => {
      assert.deepEqual(readApplicationPagesState(applicationApi), discovered.state);
      assertProtectionWriteWindow();
    };
  });
  const result = await prepareApplicationReleaseDraft(expected, files, {
    api: applicationApi,
    upload: uploadApplicationReleaseAsset,
    retainAssembly(assembly) {
      return retainApplicationDraftAssembly(
        applicationApi,
        expected,
        current,
        assembly,
        async () => {
          await guard(source, false);
        },
      );
    },
    async readAsset(id, maximum) {
      return readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${id}`, {
        cwd: process.cwd(),
        maxBytes: maximum,
        timeoutMs: 30000,
      });
    },
    async beforeDraftWrite() {
      await guard(source, false);
    },
  });
  assert.deepEqual(
    discoverPublishedApplicationCohort(applicationApi),
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

async function receiveOrdinaryPreparation(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
) {
  const current = execution();
  const attempt = Number(process.env.PORTCOVE_DRAFT_ATTEMPT);
  const expected = ordinaryPublicationExpected(source, attempt);
  const directory = path.resolve("work/application-draft-received");
  const names = ["prepared.json", "prior-site.json"];
  await receiveApplicationData(directory, {
    id: Number(process.env.PORTCOVE_DRAFT_ARTIFACT),
    name: `application-draft-${current.run_id}-${attempt}`,
    run_id: current.run_id,
    source: current.source,
    files: names,
    maximum_file_bytes: 128 * 1024,
    maximum_archive_bytes: 512 * 1024,
  });
  const subjects = await Promise.all(
    names.map(async (filename) => ({
      filename,
      sha256: sha256(await readFile(path.join(directory, filename))),
    })),
  );
  const preparation = await readFile(path.join(directory, "prepared.json"));
  return {
    expected,
    directory,
    preparation,
    authenticatePreparation: async () => {
      await verifyReleaseSourceAttestation(
        directory,
        "prepared.json",
        {
          source_commit: current.source,
          ref: current.ref,
          run_id: current.run_id,
          run_attempt: attempt,
          subjects,
        },
        { scope: "application-controller" },
      );
    },
  };
}

async function publishOrdinaryMetadata() {
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  const current = execution(),
    source = await readNativeApplicationSource();
  await guard(source, false);
  const received = await receiveOrdinaryPreparation(source);
  const { expected, directory, preparation } = received;
  const result = await publishPreparedApplicationRelease(expected, preparation, {
    api: applicationApi,
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
      const discovered = discoverPublishedApplicationCohort(applicationApi);
      assert.deepEqual(
        discovered.state,
        prior.provider,
        "prior Pages actor changed before publication",
      );
      await readPublicApplicationSiteMarker(prior.site);
      assert.deepEqual(
        readApplicationPagesState(applicationApi),
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

async function publishBootstrapMetadata() {
  const source = await readNativeApplicationSource();
  if (source.purpose === "metadata-renewal")
    assert.equal(source.execution_path, "metadata-maintenance");
  await guard(source, false);
  const current = execution();
  const { directory, attempt } = await receiveApplicationAssembly();
  assert.ok(isRecord(source.run_custody));
  const token = process.env.GH_TOKEN;
  assert.ok(token && token.length <= 16384 && !/[\r\n\0]/u.test(token));
  const expected = {
    release_id: Number(source.run_custody.release_id),
    custody: inspectApplicationRunCustody(source.run_custody.custody),
    binding: publicationBinding(source, attempt),
  };
  const files = new Map(
    await Promise.all(
      bootstrapAssetNames.map(
        async (name) => [name, await readFile(path.join(directory, name))] as const,
      ),
    ),
  );
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
    const scratch = await mkdtemp(
      path.join(process.env.RUNNER_TEMP!, "application-renewal-recovery-"),
    );
    let publicPrior: Awaited<ReturnType<typeof readApplicationPriorPublication>> | undefined;
    let lineage: Awaited<ReturnType<typeof readForwardRenewalPreimage>>["lineage"] | undefined;
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
        if (!publicPrior) {
          if (source.renewal_parent === undefined)
            publicPrior = await readApplicationPriorPublication(scratch);
          else {
            const forward = await readForwardRenewalPreimage(source, scratch);
            lineage = forward.lineage;
            publicPrior = forward;
          }
        }
        const { prior, discovered } = publicPrior;
        assert.equal(raw.prior_generation, prior.receipt.site.generation);
        assert.equal(raw.prior_repository_sha256, prior.receipt.publication.repository_sha256);
        await readPublicApplicationSiteMarker(prior.receipt.site);
        assert.deepEqual(discoverPublishedApplicationCohort(applicationApi, lineage), discovered);
        await guard(source);
        return () => {
          assert.deepEqual(readApplicationPagesState(applicationApi), discovered.state);
          assertProtectionWriteWindow();
        };
      },
    );
  }
  const result = await publishApplicationMetadataRelease(
    {
      api: applicationApi,
      retainAssembly(assembly) {
        return retainApplicationDraftAssembly(
          applicationApi,
          expected,
          current,
          assembly,
          async () => {
            await guard(source, false);
          },
        );
      },
      async beforeWrite() {
        await guard(source);
        return assertProtectionWriteWindow;
      },
      async readAsset(id, maximumBytes) {
        return readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${id}`, {
          cwd: process.cwd(),
          maxBytes: maximumBytes,
          timeoutMs: 30000,
        });
      },
      async upload(releaseId, name, bytes) {
        // Fixed ID/name endpoint; no provider-supplied URL or credential redirect.
        const response = await fetch(
          `https://uploads.github.com/repos/boburning/portcove/releases/${releaseId}/assets?name=${name}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": name.endsWith(".zip") ? "application/zip" : "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: new Uint8Array(bytes),
            redirect: "error",
            signal: AbortSignal.timeout(30000),
          },
        );
        // The exact asset inventory/byte readback decides ambiguous outcomes.
        await response.body?.cancel();
        assert.equal(response.status, 201);
      },
    },
    expected,
    files.get(bootstrapAssetNames[1])!,
    files.get(bootstrapAssetNames[0])!,
  );
  await writeApplicationJson("work/application-publication/result.json", result);
  await applicationOutput("release_id", result.release_id);
  await applicationOutput("site_generation", result.site_generation);
  await applicationOutput("attempt", current.run_attempt);
}

async function prepareOrdinaryFeed() {
  assert.ok(!process.env.PORTCOVE_SIGNING_KEY && !process.env.PORTCOVE_OBSERVER_TOKEN);
  const source = await readNativeApplicationSource();
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
    api: applicationApi,
    async authenticateRelease(identity) {
      const verified: unknown = JSON.parse(
        applicationGh([
          "release",
          "verify",
          identity.tag,
          "--repo",
          "boburning/portcove",
          "--format",
          "json",
        ]),
      );
      inspectApplicationReleaseAttestation(verified, identity);
    },
    async readAsset(id, maximum) {
      return readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${id}`, {
        cwd: process.cwd(),
        maxBytes: maximum,
        timeoutMs: 30000,
      });
    },
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
  const before = readApplicationPagesState(applicationApi);
  try {
    assertBootstrapPagesActor(before, input.site.generation, expected.custody.runs);
    await readPublicApplicationSite(input.site);
    assert.deepEqual(readApplicationPagesState(applicationApi), before);
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
    assert.deepEqual(readApplicationPagesState(applicationApi), discovered.state);
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

async function prepareBootstrapFeed() {
  // Bootstrap uses its publisher; renewal/recovery uses key-free feed staging.
  // Both re-fetch the immutable Release instead of a temporary assembly ZIP.
  const source = await readApplicationJson(path.join(sourceDirectory, "source.json"));
  assert.ok(isRecord(source));
  await guard(source, false);
  const current = execution();
  const attempt =
    source.purpose === "metadata-bootstrap"
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
      : declared;
  const input = await readImmutableApplicationMetadataFeed(
    {
      release_id: Number(source.run_custody.release_id),
      custody: inspectApplicationRunCustody(source.run_custody.custody),
      binding,
    },
    {
      api: applicationApi,
      async readAsset(id, maximum) {
        return readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${id}`, {
          cwd: process.cwd(),
          maxBytes: maximum,
          timeoutMs: 30000,
        });
      },
      async authenticateAssembly(assets, producer, assemblyAttempt) {
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
    },
  );
  if (source.purpose === "metadata-renewal") {
    await authenticateApplicationPublicRepository(input.files, input.publication, verifier);
    const before = readApplicationPagesState(applicationApi);
    try {
      assertBootstrapPagesActor(
        before,
        input.site.generation,
        inspectApplicationRunCustody(source.run_custody.custody).runs,
      );
      await readPublicApplicationSite(input.site);
      assert.deepEqual(readApplicationPagesState(applicationApi), before);
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
      const { discovered, prior } = await readApplicationPriorPublication(verifier, lineage);
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
      assert.deepEqual(readApplicationPagesState(applicationApi), discovered.state);
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
  const receipt = await verifyBootstrapPagesArtifact(
    {
      artifact_id: Number(process.env.PORTCOVE_PAGES_ARTIFACT),
      control_commit: current.source,
      run_id: current.run_id,
      producer_attempt: current.run_attempt,
      tar: { bytes: tar.length, sha256: sha256(tar) },
    },
    {
      api: applicationApi,
      async readArchive(id, maximum) {
        return readGitHubArtifactArchive(`repos/boburning/portcove/actions/artifacts/${id}/zip`, {
          cwd: process.cwd(),
          maxBytes: maximum,
          timeoutMs: 30000,
        });
      },
    },
  );
  await writeApplicationJson("work/application-feed/pages.json", {
    ...receipt,
    site_generation: site.site_generation,
  });
  await applicationOutput("attempt", current.run_attempt);
}

async function preflightBootstrapSite() {
  const source = await readNativeApplicationSource();
  const localFeed = source.purpose !== "metadata-bootstrap";
  const hasPrior = localFeed;
  if (!localFeed) await prepareBootstrapFeed();
  const current = execution();
  const attempt = localFeed
    ? current.run_attempt
    : Number(process.env.PORTCOVE_PUBLICATION_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const publisher = path.resolve("work/application-publisher");
  if (!localFeed)
    await receiveApplicationData(publisher, {
      id: Number(process.env.PORTCOVE_PUBLICATION_RECEIPT_ARTIFACT),
      name: `application-publication-${current.run_id}-${attempt}`,
      source: current.source,
      run_id: current.run_id,
      files: [
        "application-publication/result.json",
        "application-feed/receipt.json",
        "application-feed/pages.json",
      ],
      maximum_file_bytes: 2 * 1024 ** 2,
      maximum_archive_bytes: 8 * 1024 ** 2,
    });
  const captured = await readApplicationJson(
    localFeed
      ? "work/application-feed/pages.json"
      : path.join(publisher, "application-feed/pages.json"),
  );
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
  const pages = await verifyBootstrapPagesArtifact(
    {
      artifact_id: Number(process.env.PORTCOVE_PAGES_ARTIFACT),
      control_commit: current.source,
      run_id: current.run_id,
      producer_attempt: attempt,
      tar: { bytes: captured.tar.bytes, sha256: captured.tar.sha256 },
    },
    {
      api: applicationApi,
      async readArchive(id, maximum) {
        return readGitHubArtifactArchive(`repos/boburning/portcove/actions/artifacts/${id}/zip`, {
          cwd: process.cwd(),
          maxBytes: maximum,
          timeoutMs: 30000,
        });
      },
    },
  );
  const { site_generation: capturedGeneration, ...captureBody } = captured;
  assert.equal(capturedGeneration, feed.site_generation);
  assert.deepEqual(pages, captureBody);
  assert.ok(isRecord(feed.site) && typeof feed.site.generation === "string");
  const site = inspectSiteGeneration(feed.site, feed.site.generation);
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
  let preimage;
  try {
    const before = readApplicationPagesState(applicationApi);
    assertBootstrapPagesActor(before, site.generation, custody.runs);
    await readPublicApplicationSite(site);
    assert.deepEqual(readApplicationPagesState(applicationApi), before);
    preimage = { kind: "desired", provider: before };
  } catch {
    if (hasPrior) {
      const prior = await readApplicationJson("work/application-feed/prior-site.json", 128 * 1024);
      assert.ok(isRecord(prior) && isRecord(prior.site) && isRecord(prior.provider));
      assert.equal(prior.site.generation, site.previous_generation);
      const previous = inspectSiteGeneration(prior.site, site.previous_generation!);
      assert.deepEqual(readApplicationPagesState(applicationApi), prior.provider);
      await readPublicApplicationSite(previous);
      assert.deepEqual(
        readApplicationPagesState(applicationApi),
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
      );
      const provider = readApplicationPagesState(applicationApi);
      assert.deepEqual(provider, descriptor.provider);
      preimage = { kind: "initial", provider };
    }
  }
  await guard(source, false);
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
    preimage,
    ...(windowsCandidate ? { windows_candidate: windowsCandidate } : {}),
  });
  await applicationOutput("attempt", current.run_attempt);
}

async function deployBootstrapSite(readOnly = false) {
  const source = await readNativeApplicationSource();
  const controls = await guard(source, false);
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
  const preimageKind = plan.preimage.kind;
  assert.ok(preimageKind === "initial" || preimageKind === "prior" || preimageKind === "desired");
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
  const hasPrior = (facts: typeof controls) =>
    facts.budget.runs.some((run) => run.feed_executions.length > 0);
  const prior = hasPrior(controls);
  const deadline = performance.now() + 90000;
  const provider = createPagesProviderTransport({}, deadline);
  const result = await executeBootstrapPages(
    {
      artifact_id: artifactId,
      control_commit: current.source,
      site,
      prior_feed_execution: prior,
      preimage: readOnly ? "desired" : preimageKind,
    },
    {
      provider,
      deadline,
      async beforeWrite() {
        assert.equal(readOnly, false, "public readback has no deployment authority");
        const fresh = await guard(source);
        assert.equal(hasPrior(fresh), false, "earlier feed execution requires read-only recovery");
        if (source.purpose !== "metadata-bootstrap")
          assertCurrentApplicationPublication(plan.publication);
        return assertProtectionWriteWindow;
      },
      async assertPreimage() {
        assert.deepEqual(
          readApplicationPagesState(applicationApi),
          preimage.provider,
          "public deployment changed after preflight",
        );
        const response = applicationApi.request(
          "GET",
          `repos/boburning/portcove/actions/artifacts/${artifactId}`,
        );
        assert.equal(response.status, 200);
        assert.ok(
          isRecord(response.body) &&
            response.body.expired === false &&
            isRecord(response.body.workflow_run),
        );
        assert.equal(response.body.id, artifact.id);
        assert.equal(response.body.name, artifact.name);
        assert.equal(response.body.size_in_bytes, artifact.bytes);
        assert.equal(response.body.digest, `sha256:${String(artifact.sha256)}`);
        assert.equal(response.body.workflow_run.head_sha, current.source);
        assert.equal(response.body.workflow_run.id, Number(current.run_id));
        if (preimageKind === "prior") {
          assert.ok(isRecord(preimage.site));
          const previous = inspectSiteGeneration(preimage.site, site.previous_generation!);
          await readPublicApplicationSite(previous, deadline);
          assert.deepEqual(
            readApplicationPagesState(applicationApi),
            preimage.provider,
            "prior site actor changed before ordinary deployment",
          );
          assertCurrentApplicationPublication(plan.publication);
          return;
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
      },
      async providerReadback() {
        const state = readApplicationPagesState(applicationApi);
        assertBootstrapPagesActor(state, site.generation, custody.runs);
        return state;
      },
      publicReadback: () => readPublicApplicationSite(site, deadline),
      wait: () => pause(2000),
    },
  );
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
  const runJobs = applicationGet(
    `actions/runs/${current.run_id}/attempts/${attempt}/jobs?per_page=100`,
  );
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
    api: applicationApi,
    async authenticateRelease(identity) {
      const verified: unknown = JSON.parse(
        applicationGh([
          "release",
          "verify",
          identity.tag,
          "--repo",
          "boburning/portcove",
          "--format",
          "json",
        ]),
      );
      inspectApplicationReleaseAttestation(verified, identity);
    },
    async readAsset(id, maximum) {
      return readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${id}`, {
        cwd: process.cwd(),
        maxBytes: maximum,
        timeoutMs: 30000,
      });
    },
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
    assert.deepEqual(readApplicationPagesState(applicationApi), discovered.state);
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
  const producer = () =>
    inspectApplicationPublicInstalledProducer(
      applicationGet(`actions/runs/${current.run_id}/attempts/${attempt}/jobs?per_page=100`),
      { run_id: current.run_id, run_attempt: attempt, source: current.source },
    );
  const job = producer();
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
  assert.deepEqual(producer(), job);
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
  const current = execution();
  const source = await readNativeApplicationSource();
  await guard(source, false);
  // This process alone has the existing Administration-write App token. The
  // collector issues GETs only; no signing or publication key is present here.
  assert.equal(process.env.PORTCOVE_OBSERVER_INSTALLATION_ID, "177226788");
  const phase = process.env.PORTCOVE_PROTECTION_PHASE ?? "";
  assert.ok(
    [
      "payload",
      "metadata",
      "snapshot",
      "timestamp",
      "draft-recovery",
      "publication",
      "feed",
    ].includes(phase),
  );
  const token = process.env.PORTCOVE_OBSERVER_TOKEN;
  assert.ok(token && !/[\r\n\0]/u.test(token) && token.length <= 16384);
  const environment = {
    ...payloadSigningEnvironment(path.resolve("work/observer-cli")),
    PATH: process.env.PATH,
    GH_HOST: "github.com",
    GH_TOKEN: token,
  };
  const observer = new GitHubApiClient(
    createGitHubRunner({
      timeoutMs: 30000,
      maxBuffer: 4 * 1024 ** 2,
      spawn: (command, args, options) => spawnSync(command, args, { ...options, env: environment }),
    }),
  );
  const observation = observeReleaseInputProtections(observer, { releasePublication: true });
  const interpreted = requireReleaseImmutabilityPolicy(observation);
  assert.equal(
    interpreted.inventory_sha256,
    process.env.PORTCOVE_APPLICATION_RELEASE_PROTECTION_SHA256,
  );
  await writeApplicationJson("work/application-protection/protection.json", {
    schema_version: 1,
    phase,
    source: current.source,
    run_id: current.run_id,
    attempt: current.run_attempt,
    observation,
  });
  await applicationOutput("attempt", current.run_attempt);
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
  await guard(source, false);
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
  const controls = await guard(source);
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
    assert.equal(invoke(["--version"]).toString().trim(), "tauri-cli 2.12.2");
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
  const commit = applicationGet(`git/commits/${current.source}`);
  assert.ok(
    isRecord(commit) &&
      commit.sha === current.source &&
      isRecord(commit.tree) &&
      typeof commit.tree.sha === "string",
  );
  const configuration = applicationGet(
    `contents/apps/desktop/src-tauri/tauri.conf.json?ref=${source.prepared.prepared_commit}`,
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
    (pathname) =>
      applicationApi.request(
        "GET",
        `repos/boburning/portcove/contents/${pathname}?ref=${productSource}`,
      ),
    (blob) => applicationApi.request("GET", `repos/boburning/portcove/git/blobs/${blob}`),
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
    applicationGet(`actions/runs/${current.run_id}/attempts/${attempt}/jobs?per_page=100`),
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
  const owner = readApplicationBudgetOwner(applicationApi, {
    release_id: Number(source.run_custody.release_id),
    custody,
  });
  const original = readApplicationBudgetOwner(applicationApi, authority);
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
  const bytes = readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${archive.id}`, {
    cwd: process.cwd(),
    maxBytes: archive.bytes,
    timeoutMs: 30000,
  });
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
  const { discovered, prior } = forward ?? (await readApplicationPriorPublication(scratch));
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
  const plan = readApplicationMetadataContextPlan(
    applicationApi,
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
    discoverPublishedApplicationCohort(applicationApi, forward?.lineage),
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
  if (source.purpose !== "metadata-bootstrap") {
    assert.ok(isRecord(source.run_custody));
    const identity = applicationMetadataContextIdentity(
      await readBoundedReleaseContextFiles(context),
    );
    await retainApplicationMetadataContext(
      applicationApi,
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
    await guard(source, false);
  }
  await packApplicationContext(context, "work/application-context-output/context-bundle.json");
  await applicationOutput("attempt", current.run_attempt);
}

async function assertReservedApplicationContext(
  source: Awaited<ReturnType<typeof readNativeApplicationSource>>,
  context: string,
) {
  if (source.purpose === "metadata-bootstrap") return;
  const current = execution(),
    attempt = Number(process.env.PORTCOVE_CONTEXT_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  assert.ok(isRecord(source.run_custody));
  const plan = readApplicationMetadataContextPlan(
    applicationApi,
    {
      release_id: Number(source.run_custody.release_id),
      custody: inspectApplicationRunCustody(source.run_custody.custody),
    },
    { ...current, run_attempt: attempt },
  );
  assert.ok(plan.existing, "context producer has no retained native metadata reservation");
  const identity = applicationMetadataContextIdentity(
    await readBoundedReleaseContextFiles(context),
  );
  assert.deepEqual(
    {
      ...identity,
      opportunity: String(source.opportunity),
      run_id: current.run_id,
      run_attempt: attempt,
      control_commit: current.source,
      control_ref: current.ref,
    },
    plan.existing,
    "context differs from the original native producer reservation",
  );
}

async function signMetadata(role: (typeof onlineRoles)[number]) {
  const current = execution();
  const source = await readNativeApplicationSource();
  if (source.purpose === "metadata-renewal")
    assert.equal(source.execution_path, "metadata-maintenance");
  const context = await receiveApplicationContext();
  await assertReservedApplicationContext(source, context);
  const configuration = await readApplicationJson(path.join(context, "context.json"), 65536);
  assert.ok(isRecord(configuration));
  const onlineTargets = configuration.top_level_targets_profile === "online-unchanged-authority-v1";
  if (role === "targets" && !onlineTargets) {
    await applicationOutput("changed", false);
    return;
  }
  const dependencies = ["releases", "preview", "stable", ...(onlineTargets ? ["targets"] : [])];
  const signed =
    role === "snapshot" || role === "timestamp"
      ? await receiveSignedRoles(context, [
          ...dependencies,
          ...(role === "timestamp" ? ["snapshot"] : []),
        ])
      : null;
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
  await guard(source);
  await assertReservedApplicationContext(source, context);
  assertProtectionWriteWindow();
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

async function assembleMetadata() {
  const source = await readNativeApplicationSource();
  if (source.purpose === "metadata-renewal")
    assert.equal(source.execution_path, "metadata-maintenance");
  const context = await receiveApplicationContext();
  await assertReservedApplicationContext(source, context);
  const configuration = await readApplicationJson(path.join(context, "context.json"), 65536);
  assert.ok(isRecord(configuration));
  if (source.purpose === "metadata-renewal")
    assertApplicationRenewalContext(await readBoundedReleaseContextFiles(context), source);
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
  await guard(source, false);
  const scratch = path.join(process.env.RUNNER_TEMP ?? "", "application-assembly");
  await mkdir(scratch);
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
      env: payloadSigningEnvironment(scratch),
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
    },
  );
  const raw: unknown = JSON.parse(report.toString("utf8"));
  assert.ok(isRecord(raw));
  await writeApplicationJson("work/application-assembly/assembly.json", raw);
  if (source.purpose === "metadata-bootstrap") {
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
    const retained = await materializeInitialApplicationRehearsal(
      await readApplicationJson(
        "release/bootstrap-public-inputs/application/initial-site-preimage.json",
      ),
      descriptor.initial_site_preimage_sha256,
      scratch,
    );
    const output = path.resolve("work/application-site");
    await mkdir(output);
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
    const { discovered, prior } = forward ?? (await readApplicationPriorPublication(scratch));
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
      discoverPublishedApplicationCohort(applicationApi, forward?.lineage),
      discovered,
      "prior cohort changed during actual site assembly",
    );
    await guard(source, false);
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
    else if (process.argv[2] === "publication-prepare") await prepareOrdinaryPublication();
    else if (process.argv[2] === "publication") {
      if (process.env.PORTCOVE_DRAFT_ARTIFACT) await publishOrdinaryMetadata();
      else await publishBootstrapMetadata();
    } else if (process.argv[2] === "prepare-feed") {
      const source = await readNativeApplicationSource();
      if (source.purpose === "application-release") await prepareOrdinaryFeed();
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
  } catch {
    console.error("Fixed application role failed; private subprocess output is not retained.");
    process.exitCode = 1;
  }
}
