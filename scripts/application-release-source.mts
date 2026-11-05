/** Source selection and the existing mechanical version transform. Native
 * Release notes retain run/preparation custody; no alternate coordinator is
 * created and custody supplies no signing or publication authority. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import {
  applicationApi,
  applicationGet,
  applicationOutput,
  readApplicationJson,
  writeApplicationJson,
  sha256,
} from "./application-release-io.mts";
import { semanticReviewCheckName } from "./release-control-phases.mts";
import {
  readIndependentSemanticCheckInventory,
  selectLatestApplicationSemanticCheck,
} from "./release-semantic-disposition-reader.mts";
import { readIndependentSemanticReview, readPublicationPause } from "./release-control-inputs.mts";
import {
  registerApplicationReleaseRun,
  retainApplicationPreparation,
  inspectApplicationQualificationIdentity,
  readApplicationRunNotes,
  registerApplicationBudgetRun,
  readApplicationBudgetOwner,
  inspectApplicationReleaseReference,
} from "./application-release-run.mts";
import { readApplicationJobBudget } from "./application-release-budget.mts";
import { inspectApplicationMetadataPublicationReceipt } from "./application-release-publication.mts";
import type {
  ApplicationBudgetContext,
  ApplicationRunCustody,
} from "./application-release-run.mts";
import {
  inspectInitialApplicationDescriptor,
  inspectApplicationRenewalSource,
} from "./application-release-context.mts";
import {
  readApplicationPriorPublication,
  readApplicationImmutableMetadata,
  readApplicationPendingLineage,
  assertApplicationForwardPreimage,
  discoverPublishedApplicationCohort,
} from "./application-release-feed.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { materializeInitialApplicationRehearsal } from "./release-site-readback.mts";
import { validateOpportunity } from "./release-coordinator.mts";
import { collectReleaseSourceChanges } from "./release-source-changes.mts";
import {
  createReleasePublicationReader,
  peelReleaseReference,
} from "./release-publication-inventory.mts";
import {
  parseVersionClassification,
  classifyApplicationVersion,
  compareApplicationVersionPrecedence,
} from "../apps/desktop/scripts/release-version-policy.mts";
import { prepareReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import { publishPreparedReleaseObjects } from "./release-prepared-transport.mts";
import {
  readWindowsApplicationQualification,
  selectWindowsApplicationQualificationRun,
} from "./application-release-qualification.mts";
import {
  inspectApplicationReleaseExecution,
  inspectApplicationSpendingAppointment,
  verifyApplicationReleaseTrust,
} from "./application-release-policy.mts";

const semanticProducer = {
  schema_version: 2,
  purpose: "application",
  review_app_id: 5555053,
  review_check_name: semanticReviewCheckName,
};

export function inspectApplicationSemanticSelection(raw: unknown, source: string, tree: string) {
  assert.ok(isRecord(raw) && isRecord(raw.output) && typeof raw.output.summary === "string");
  assert.ok(Buffer.byteLength(raw.output.summary) <= 65536);
  assert.equal(raw.status, "completed");
  assert.equal(raw.conclusion, "success");
  const report: unknown = JSON.parse(raw.output.summary);
  assert.ok(isRecord(report));
  const opportunity = validateOpportunity(report.opportunity);
  assert.equal(opportunity.source_commit, source);
  assert.equal(opportunity.source_tree, tree);
  assert.equal(opportunity.classification.change_set_scope, "portcove-release-net-tree-delta-v1");
  parseVersionClassification(opportunity.classification);
  return opportunity;
}

export async function readApplicationSemanticSelection(source: string) {
  assert.match(source, /^[a-f0-9]{40}$/u);
  const commit = applicationGet(`git/commits/${source}`);
  assert.ok(
    isRecord(commit) &&
      commit.sha === source &&
      isRecord(commit.tree) &&
      typeof commit.tree.sha === "string",
  );
  assert.match(commit.tree.sha, /^[a-f0-9]{40}$/u);
  const inventory = readIndependentSemanticCheckInventory(applicationApi, semanticProducer, source);
  // A later pending, failed or refused independent decision cannot be hidden by
  // falling back to an older success. The fixed App owns this Check namespace.
  const check = selectLatestApplicationSemanticCheck(inventory.records);
  const opportunity = inspectApplicationSemanticSelection(check, source, commit.tree.sha);
  const review = readIndependentSemanticReview(
    applicationApi,
    semanticProducer,
    opportunity,
    Number(check.id),
  );
  const changes = collectReleaseSourceChanges(applicationApi, opportunity);
  assert.equal(changes.change_set_sha256, opportunity.change_set_sha256);
  inventory.assertUnchanged();
  assert.ok(isRecord(check.output) && typeof check.output.summary === "string");
  return {
    opportunity,
    check_id: Number(check.id),
    review_sha256: sha256(Buffer.from(review)),
    summary_sha256: sha256(Buffer.from(check.output.summary)),
    tree: commit.tree.sha,
  };
}

/** Current main qualification observation for automatic routing. It performs
 * no dispatch, eligibility write, or reservation. The source job re-admits. */
export async function readCurrentApplicationWakeQualification() {
  const main = () => {
    const ref = applicationGet("git/ref/heads/main");
    assert.ok(isRecord(ref) && ref.ref === "refs/heads/main" && isRecord(ref.object));
    assert.equal(ref.object.type, "commit");
    assert.ok(typeof ref.object.sha === "string" && /^[a-f0-9]{40}$/u.test(ref.object.sha));
    return ref.object.sha;
  };
  const source = main();
  const route = `actions/workflows/release.yml/runs?branch=main&event=workflow_dispatch&head_sha=${source}&per_page=100`;
  const observe = () => selectWindowsApplicationQualificationRun(applicationGet(route), source);
  const selected = observe();
  const qualification =
    selected.decision === "candidate"
      ? await readWindowsApplicationQualification(applicationApi, selected.run_id, source)
      : undefined;
  if (qualification) {
    assert.equal(qualification.attempt, selected.run_attempt);
    assert.equal(qualification.workflow, ".github/workflows/release.yml");
  }
  assert.deepEqual(observe(), selected, "qualification selection changed during readback");
  assert.equal(main(), source, "main changed during qualification selection");
  return { source, ...selected, ...(qualification ? { qualification } : {}) };
}

async function selectForQualification() {
  assert.equal(process.env.GITHUB_REPOSITORY, "boburning/portcove");
  assert.equal(process.env.GITHUB_REPOSITORY_ID, "1354613114");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  const source = process.env.GITHUB_SHA ?? "";
  assert.match(source, /^[a-f0-9]{40}$/u);
  const commit = applicationGet(`git/commits/${source}`);
  assert.ok(isRecord(commit) && isRecord(commit.tree) && typeof commit.tree.sha === "string");
  const reader = createReleasePublicationReader(applicationApi);
  const releases = reader
    .releases()
    .filter(
      (release) =>
        !release.draft && release.published_at !== null && release.tag_name.startsWith("v"),
    );
  for (const release of releases) classifyApplicationVersion(release.tag_name.slice(1));
  releases.sort((left, right) =>
    compareApplicationVersionPrecedence(right.tag_name.slice(1), left.tag_name.slice(1)),
  );
  const latest = releases[0];
  assert.ok(latest, "an actual published dependency-review baseline is required");
  const tag = reader.tags().find((value) => value.name === latest.tag_name);
  assert.ok(tag);
  const base = peelReleaseReference(tag);
  const details = applicationGet(`releases/${latest.id}`);
  assert.ok(
    isRecord(details) &&
      details.immutable === true &&
      details.tag_name === latest.tag_name &&
      details.draft === false,
  );
  const version = execFileSync(
    process.execPath,
    ["scripts/check-release-metadata.mts", "--print-version"],
    { encoding: "utf8", timeout: 30000 },
  ).trim();
  await writeApplicationJson("work/application-selection/selection.json", {
    source,
    tree: commit.tree.sha,
    base,
    scope: "qualification only; no classification or publication authority",
  });
  await applicationOutput("source", source);
  await applicationOutput("tree", commit.tree.sha);
  await applicationOutput("version", version);
  await applicationOutput("base", base);
}

async function beforeSourceRecord() {
  inspectApplicationReleaseExecution(process.env);
  assert.equal(
    process.env.PORTCOVE_APPLICATION_RELEASE_ACTIVE,
    "true",
    "native production authority remains held",
  );
  inspectApplicationSpendingAppointment(process.env);
  assert.equal(
    sha256(await readFile(".github/workflows/release.yml")),
    process.env.PORTCOVE_APPLICATION_RELEASE_WORKFLOW_SHA256,
  );
  assert.equal(
    readPublicationPause(applicationApi).publication_paused,
    false,
    "publication paused",
  );
}

async function beforeSourceWrite(
  knownRunIds: readonly string[],
  budgetContext?: ApplicationBudgetContext,
) {
  await beforeSourceRecord();
  readApplicationJobBudget(
    knownRunIds,
    process.argv[2] === "bootstrap"
      ? "metadata-bootstrap"
      : ["renew", "recover-metadata", "renew-unserved"].includes(process.argv[2] ?? "")
        ? "metadata-renewal"
        : "application-release",
    process.argv[2] === "recover"
      ? "immutable-recovery"
      : process.argv[2] === "recover-metadata"
        ? "metadata-recovery"
        : ["renew", "renew-unserved"].includes(process.argv[2] ?? "")
          ? "metadata-maintenance"
          : "ordinary",
    budgetContext,
  );
}

async function prepare() {
  const execution = inspectApplicationReleaseExecution(process.env);
  await beforeSourceRecord();
  await verifyApplicationReleaseTrust();
  const original = process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY ?? "";
  assert.match(original, /^[a-f0-9]{40}$/u);
  const commit = applicationGet(`git/commits/${original}`);
  assert.ok(
    isRecord(commit) &&
      commit.sha === original &&
      isRecord(commit.tree) &&
      typeof commit.tree.sha === "string",
  );
  assert.match(commit.tree.sha, /^[a-f0-9]{40}$/u);
  const runId = Number(process.env.PORTCOVE_QUALIFICATION_RUN);
  assert.ok(Number.isSafeInteger(runId) && runId > 0);
  const run = applicationGet(`actions/runs/${runId}`);
  assert.ok(isRecord(run) && typeof run.head_sha === "string");
  assert.equal(run.path, ".github/workflows/release.yml");
  assert.equal(process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY, run.head_sha);
  const qualification = await readWindowsApplicationQualification(
    applicationApi,
    runId,
    run.head_sha,
  );
  if (process.env.PORTCOVE_WAKE_RUN_ID) {
    assert.match(process.env.PORTCOVE_WAKE_RUN_ID, /^[1-9][0-9]{0,15}$/u);
    assert.equal(process.env.PORTCOVE_QUALIFICATION_ATTEMPT, String(qualification.attempt));
  }
  const selected = await readApplicationSemanticSelection(run.head_sha);
  assert.ok(selected.opportunity.meaningful && !selected.opportunity.documentation_only);
  if (process.env.PORTCOVE_WAKE_RUN_ID) {
    const main = applicationGet("git/ref/heads/main");
    assert.ok(isRecord(main) && main.ref === "refs/heads/main" && isRecord(main.object));
    assert.equal(main.object.type, "commit");
    assert.equal(main.object.sha, original, "automatic release source is no longer current main");
  }
  const beforeWrite = beforeSourceWrite;
  const registration = await registerApplicationReleaseRun(
    applicationApi,
    execution,
    original,
    commit.tree.sha,
    original,
    beforeWrite,
  );
  const publicationReader = createReleasePublicationReader(applicationApi);
  const releases = publicationReader.releases();
  const publishedHistory = releases
    .filter(
      (value) => !value.draft && value.published_at !== null && value.tag_name.startsWith("v"),
    )
    .map((value) => {
      const version = value.tag_name.slice(1);
      classifyApplicationVersion(version);
      return version;
    });
  const retained = registration.custody.preparation;
  if (retained)
    assert.deepEqual(
      retained.classification,
      parseVersionClassification(selected.opportunity.classification),
      "reserved source classification changed; no reallocation",
    );
  const history = retained?.published_versions ?? publishedHistory;
  // Reuse/retirement of a previously published prepared source is handled by the
  // immutable-release recovery path, never by allocating the source twice.
  const tags = publicationReader.tags();
  const allocations = publicationReader.readAllocations(tags, "portcove-production");
  assert.ok(
    !allocations.allocations.some((value) => value.source_commit === run.head_sha),
    "source already allocated: use immutable release/feed recovery",
  );
  assert.ok(process.env.RUNNER_TEMP);
  const repository = path.join(process.env.RUNNER_TEMP, "application-version-source.git");
  await mkdir(repository);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 16 * 1024 ** 2,
      stdio: ["pipe", "pipe", "pipe"],
    });
  git(["init", "--bare", repository]);
  git([
    "-C",
    repository,
    "-c",
    "core.hooksPath=/dev/null",
    "fetch",
    "--no-tags",
    "--depth=1",
    "https://github.com/boburning/portcove.git",
    run.head_sha,
  ]);
  const prepared = await prepareReleaseVersion(
    repository,
    selected.opportunity.classification,
    history,
  );
  const custody = await retainApplicationPreparation(
    applicationApi,
    registration.release_id,
    registration.custody,
    {
      source_commit: original,
      source_tree: selected.tree,
      prepared_commit: prepared.prepared_commit,
      prepared_tree: prepared.prepared_tree,
      version: prepared.version,
      intent_sha256: prepared.intent_sha256,
      classification: parseVersionClassification(selected.opportunity.classification),
      published_versions: history,
      qualification: inspectApplicationQualificationIdentity(qualification, original),
    },
    beforeWrite,
  );
  const preparedObjects = await publishPreparedReleaseObjects(
    repository,
    {
      source_commit: original,
      source_tree: selected.tree,
      prepared_commit: prepared.prepared_commit,
      prepared_tree: prepared.prepared_tree,
      version: prepared.version,
      intent_sha256: prepared.intent_sha256,
    },
    {
      api: applicationApi,
      beforeWrite: () =>
        beforeWrite(registration.known_run_ids, { release_id: registration.release_id, custody }),
    },
  );
  const packet = {
    schema_version: 1,
    authority: "none",
    purpose: "application-release",
    opportunity: run.head_sha,
    original_source: run.head_sha,
    original_tree: selected.tree,
    prepared,
    classification: parseVersionClassification(selected.opportunity.classification),
    published_versions: history,
    qualification,
    semantic: selected,
    run_custody: { release_id: registration.release_id, custody },
    prepared_objects: preparedObjects,
    control_commit: execution.source,
    control_ref: execution.ref,
    run_id: execution.run_id,
    producer_attempt: execution.run_attempt,
  };
  await writeApplicationJson("work/application-source/source.json", packet);
  await applicationOutput("source_attempt", execution.run_attempt);
  await applicationOutput("known_runs", JSON.stringify(registration.known_run_ids));
  for (const [name, value] of Object.entries({
    source: run.head_sha,
    original_tree: selected.tree,
    prepared_source: prepared.prepared_commit,
    prepared_tree: prepared.prepared_tree,
    version: prepared.version,
    classification: JSON.stringify(packet.classification),
    published_versions: JSON.stringify(history),
  }))
    await applicationOutput(name, value);
}

/** Re-enter only an existing immutable source opportunity. This never allocates
 * a version, rebuilds a package or signs metadata. Original custody and actual
 * opportunity history keep every earlier execution inside the same cap. */
async function recoverImmutableFeed() {
  const execution = inspectApplicationReleaseExecution(process.env);
  await verifyApplicationReleaseTrust();
  const original = process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY ?? "";
  assert.match(original, /^[a-f0-9]{40}$/u);
  const selected = await readApplicationSemanticSelection(original);
  assert.ok(selected.opportunity.meaningful && !selected.opportunity.documentation_only);
  const registration = await registerApplicationReleaseRun(
    applicationApi,
    execution,
    original,
    selected.tree,
    original,
    beforeSourceWrite,
    "immutable-only",
  );
  const preparation = registration.custody.preparation;
  assert.ok(preparation?.qualification, "original admitted qualification custody is missing");
  const qualification = preparation.qualification;
  assert.deepEqual(
    preparation.classification,
    parseVersionClassification(selected.opportunity.classification),
    "immutable source classification changed; recovery cannot reallocate it",
  );
  await writeApplicationJson("work/application-source/source.json", {
    schema_version: 1,
    authority: "none",
    purpose: "application-release",
    execution_path: "immutable-recovery",
    opportunity: original,
    original_source: original,
    original_tree: selected.tree,
    prepared: preparation,
    classification: preparation.classification,
    published_versions: preparation.published_versions,
    semantic: selected,
    qualification,
    run_custody: { release_id: registration.release_id, custody: registration.custody },
    control_commit: execution.source,
    control_ref: execution.ref,
    run_id: execution.run_id,
    producer_attempt: execution.run_attempt,
  });
  for (const [name, value] of Object.entries({
    source: original,
    original_tree: selected.tree,
    prepared_source: preparation.prepared_commit,
    prepared_tree: preparation.prepared_tree,
    version: preparation.version,
    classification: JSON.stringify(preparation.classification),
    published_versions: JSON.stringify(preparation.published_versions),
    source_attempt: execution.run_attempt,
    known_runs: JSON.stringify(registration.known_run_ids),
  }))
    await applicationOutput(name, value);
}

async function bootstrap() {
  const execution = inspectApplicationReleaseExecution(process.env);
  await verifyApplicationReleaseTrust();
  const expected = {
    descriptor_sha256: process.env.PORTCOVE_APPLICATION_BOOTSTRAP_DESCRIPTOR_SHA256 ?? "",
    setup_plan_sha256: process.env.PORTCOVE_APPLICATION_SETUP_PLAN_SHA256 ?? "",
    site_preimage_sha256: process.env.PORTCOVE_APPLICATION_INITIAL_SITE_PREIMAGE_SHA256 ?? "",
  };
  const raw: unknown = JSON.parse(process.env.PORTCOVE_APPLICATION_BOOTSTRAP_DESCRIPTOR ?? "null");
  inspectInitialApplicationDescriptor(raw, expected);
  assert.equal(process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY, expected.descriptor_sha256);
  const commit = applicationGet(`git/commits/${execution.source}`);
  assert.ok(
    isRecord(commit) &&
      commit.sha === execution.source &&
      isRecord(commit.tree) &&
      typeof commit.tree.sha === "string",
  );
  const registration = await registerApplicationReleaseRun(
    applicationApi,
    execution,
    execution.source,
    commit.tree.sha,
    expected.descriptor_sha256,
    beforeSourceWrite,
  );
  assert.equal(
    registration.custody.preparation,
    null,
    "bootstrap cannot allocate an executable release",
  );
  assert.ok(process.env.RUNNER_TEMP);
  const retained = await materializeInitialApplicationRehearsal(
    await readApplicationJson(
      "release/bootstrap-public-inputs/application/initial-site-preimage.json",
    ),
    expected.site_preimage_sha256,
    path.resolve(process.env.RUNNER_TEMP),
  );
  await writeApplicationJson("work/application-source/source.json", {
    schema_version: 1,
    authority: "none",
    purpose: "metadata-bootstrap",
    opportunity: expected.descriptor_sha256,
    bootstrap_descriptor: raw,
    bootstrap_appointment: expected,
    bootstrap_preimage: { inventory_sha256: retained.inventory_sha256, authority: "none" },
    run_custody: { release_id: registration.release_id, custody: registration.custody },
    control_commit: execution.source,
    control_ref: execution.ref,
    run_id: execution.run_id,
    producer_attempt: execution.run_attempt,
  });
  await applicationOutput("source_attempt", execution.run_attempt);
  await applicationOutput("known_runs", JSON.stringify(registration.known_run_ids));
}

async function renewPublishedMetadata() {
  const execution = inspectApplicationReleaseExecution(process.env);
  await verifyApplicationReleaseTrust();
  assert.ok(process.env.RUNNER_TEMP);
  const scratch = path.resolve(process.env.RUNNER_TEMP, "application-renewal-selection");
  await mkdir(scratch);
  // The existing reader authenticates the actual immutable assembly. The Rust
  // context factory later authenticates all physical repository bytes.
  const { discovered, prior } = await readApplicationPriorPublication(scratch);
  const basis = {
    schema_version: 1,
    kind: "application-metadata-renewal-basis",
    root_sha256: prior.receipt.publication.root_sha256,
    repository_sha256: prior.receipt.publication.repository_sha256,
    site_generation: prior.receipt.site.generation,
  };
  const opportunity = releaseCanonicalDigest(basis);
  assert.equal(process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY, opportunity);
  inspectApplicationRenewalSource({
    purpose: "metadata-renewal",
    execution_path: "metadata-maintenance",
    opportunity,
    renewal_basis: basis,
    renewal_clock: "native-context-reservation-v1",
  });
  const commit = applicationGet(`git/commits/${execution.source}`);
  assert.ok(
    isRecord(commit) &&
      commit.sha === execution.source &&
      isRecord(commit.tree) &&
      typeof commit.tree.sha === "string",
  );
  const registration = await registerApplicationReleaseRun(
    applicationApi,
    execution,
    execution.source,
    commit.tree.sha,
    opportunity,
    async (known, context) => {
      assert.deepEqual(
        discoverPublishedApplicationCohort(applicationApi),
        discovered,
        "published renewal basis changed before source registration",
      );
      await beforeSourceWrite(known, context);
    },
  );
  assert.equal(registration.custody.preparation, null);
  const packet = {
    schema_version: 1,
    authority: "none",
    purpose: "metadata-renewal",
    execution_path: "metadata-maintenance",
    opportunity,
    renewal_basis: basis,
    renewal_clock: "native-context-reservation-v1",
    run_custody: { release_id: registration.release_id, custody: registration.custody },
    control_commit: execution.source,
    control_ref: execution.ref,
    run_id: execution.run_id,
    producer_attempt: execution.run_attempt,
  };
  inspectApplicationRenewalSource(packet);
  assert.deepEqual(discoverPublishedApplicationCohort(applicationApi), discovered);
  await writeApplicationJson("work/application-source/source.json", packet);
  await applicationOutput("source_attempt", execution.run_attempt);
  await applicationOutput("known_runs", JSON.stringify(registration.known_run_ids));
}

async function retainedApplicationSemantic(custody: ApplicationRunCustody) {
  if (!custody.preparation) return undefined;
  const selected = await readApplicationSemanticSelection(custody.source);
  assert.ok(selected.opportunity.meaningful && !selected.opportunity.documentation_only);
  assert.deepEqual(
    parseVersionClassification(selected.opportunity.classification),
    custody.preparation.classification,
    "unserved payload classification changed; metadata renewal cannot restore eligibility",
  );
  return selected;
}

async function renewUnservedMetadata() {
  const execution = inspectApplicationReleaseExecution(process.env);
  await verifyApplicationReleaseTrust();
  await beforeSourceRecord();
  const pendingOpportunity = process.env.PORTCOVE_APPLICATION_PENDING_OPPORTUNITY ?? "";
  assert.match(pendingOpportunity, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
  // Application cohorts move to vVERSION; metadata cohorts keep the candidate
  // tag. The native notes inventory resolves either without allocating a version.
  const matches = createReleasePublicationReader(applicationApi)
    .releaseNotes()
    .filter(
      (release) =>
        readApplicationRunNotes(release.body ?? "")?.custody.opportunity === pendingOpportunity,
    );
  assert.equal(matches.length, 1, "pending renewal has no unique native cohort");
  const release = matches[0]!;
  assert.ok(typeof release.id === "number" && Number.isSafeInteger(release.id));
  const parent = inspectApplicationReleaseReference({
    release_id: release.id,
    opportunity: pendingOpportunity,
  });
  assert.ok(process.env.RUNNER_TEMP);
  const scratch = path.resolve(process.env.RUNNER_TEMP, "application-unserved-renewal-selection");
  await mkdir(scratch);
  const lineageDirectory = path.join(scratch, "pending-lineage");
  await mkdir(lineageDirectory);
  const lineage = await readApplicationPendingLineage(parent, lineageDirectory);
  const authority = lineage[0]!;
  assert.ok(
    (["timestamp", "snapshot", "releases", "preview", "stable"] as const).some(
      (role) => Date.parse(authority.receipt.publication.expires[role]) <= Date.now(),
    ),
    "fresh immutable metadata uses key-free feed recovery",
  );
  const { discovered, prior } = await readApplicationPriorPublication(scratch, lineage);
  assertApplicationForwardPreimage(
    authority.metadata,
    authority.receipt.publication,
    prior.receipt.publication,
  );
  const basis = {
    schema_version: 1,
    kind: "application-metadata-renewal-basis",
    root_sha256: authority.receipt.publication.root_sha256,
    repository_sha256: authority.receipt.publication.repository_sha256,
    site_generation: prior.receipt.site.generation,
  };
  const opportunity = releaseCanonicalDigest(basis);
  assert.equal(process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY, opportunity);
  const owner = readApplicationBudgetOwner(applicationApi, authority);
  const linked = await registerApplicationBudgetRun(
    applicationApi,
    authority,
    opportunity,
    execution,
    beforeSourceRecord,
  );
  const semantic = await retainedApplicationSemantic(owner.custody);
  const registration = await registerApplicationReleaseRun(
    applicationApi,
    execution,
    owner.custody.source,
    owner.custody.source_tree,
    opportunity,
    beforeSourceWrite,
    "create-or-resume",
    linked.membership,
  );
  const packet = {
    schema_version: 1,
    authority: "none",
    purpose: "metadata-renewal",
    execution_path: "metadata-maintenance",
    opportunity,
    renewal_basis: basis,
    renewal_parent: parent,
    renewal_public_prior_repository_sha256: prior.receipt.publication.repository_sha256,
    renewal_clock: "native-context-reservation-v1",
    ...(semantic ? { renewal_semantic: semantic } : {}),
    run_custody: { release_id: registration.release_id, custody: registration.custody },
    control_commit: execution.source,
    control_ref: execution.ref,
    run_id: execution.run_id,
    producer_attempt: execution.run_attempt,
  };
  inspectApplicationRenewalSource(packet);
  // Counter writes may have extended the immutable ancestor's native notes.
  // Re-authenticate that exact bounded lineage before sealing this source input.
  const finalDirectory = path.join(scratch, "final-lineage");
  await mkdir(finalDirectory);
  const freshLineage = await readApplicationPendingLineage(parent, finalDirectory);
  assert.deepEqual(discoverPublishedApplicationCohort(applicationApi, freshLineage), discovered);
  await writeApplicationJson("work/application-source/source.json", packet);
  await applicationOutput("source_attempt", execution.run_attempt);
  await applicationOutput("known_runs", JSON.stringify(registration.known_run_ids));
}

async function recoverImmutableMetadataFeed() {
  const execution = inspectApplicationReleaseExecution(process.env);
  await verifyApplicationReleaseTrust();
  await beforeSourceRecord();
  const opportunity = process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY ?? "";
  assert.match(opportunity, /^[a-f0-9]{64}$/u);
  const tag = `portcove-production-candidate-${opportunity}`;
  const release = applicationGet(`releases/tags/${tag}`);
  assert.ok(isRecord(release) && Number.isSafeInteger(release.id) && Number(release.id) > 0);
  assert.equal(release.tag_name, tag);
  const notes = readApplicationRunNotes(release.body);
  assert.ok(
    notes && notes.custody.opportunity === opportunity && notes.custody.preparation === null,
  );
  assert.ok(process.env.RUNNER_TEMP);
  const scratch = path.resolve(process.env.RUNNER_TEMP, "application-metadata-recovery-selection");
  await mkdir(scratch);
  const expected = { release_id: Number(release.id), custody: notes.custody };
  const prior = await readApplicationImmutableMetadata(expected, scratch);
  assert.ok(isRecord(prior.metadata) && prior.metadata.purpose === "metadata-renewal");
  const forward =
    prior.metadata.schema_version === 2
      ? {
          renewal_parent: inspectApplicationReleaseReference(prior.metadata.renewal_parent),
          renewal_public_prior_repository_sha256: prior.metadata.prior_repository_sha256,
        }
      : undefined;
  const basis = {
    schema_version: 1,
    kind: "application-metadata-renewal-basis",
    root_sha256: prior.receipt.publication.root_sha256,
    repository_sha256: forward
      ? prior.metadata.authority_repository_sha256
      : prior.metadata.prior_repository_sha256,
    site_generation: prior.metadata.prior_generation,
  };
  assert.ok(
    typeof basis.repository_sha256 === "string" &&
      typeof basis.site_generation === "string" &&
      typeof prior.metadata.prior_repository_sha256 === "string",
  );
  inspectApplicationMetadataPublicationReceipt(
    prior.metadata,
    {
      purpose: "metadata-renewal",
      opportunity,
      prior_repository_sha256: prior.metadata.prior_repository_sha256,
      prior_generation: basis.site_generation,
      ...(forward
        ? {
            authority_repository_sha256: basis.repository_sha256,
            renewal_parent: forward.renewal_parent,
          }
        : {}),
    },
    notes.custody,
  );
  // A forward-renewal member keeps its original owner even when this recovery
  // uses a smaller tail. Persist the authorized execution before full admission.
  if (notes.custody.budget?.kind === "member")
    await registerApplicationBudgetRun(
      applicationApi,
      expected,
      opportunity,
      execution,
      beforeSourceRecord,
    );
  const registration = await registerApplicationReleaseRun(
    applicationApi,
    execution,
    notes.custody.source,
    notes.custody.source_tree,
    opportunity,
    beforeSourceWrite,
    "immutable-metadata-only",
    notes.custody.budget,
  );
  const owner = readApplicationBudgetOwner(applicationApi, registration);
  const semantic = forward ? await retainedApplicationSemantic(owner.custody) : undefined;
  const packet = {
    schema_version: 1,
    authority: "none",
    purpose: "metadata-renewal",
    execution_path: "metadata-recovery",
    opportunity,
    renewal_basis: basis,
    ...forward,
    ...(semantic ? { renewal_semantic: semantic } : {}),
    renewal_clock: "native-context-reservation-v1",
    run_custody: { release_id: registration.release_id, custody: registration.custody },
    control_commit: execution.source,
    control_ref: execution.ref,
    run_id: execution.run_id,
    producer_attempt: execution.run_attempt,
  };
  inspectApplicationRenewalSource(packet);
  await writeApplicationJson("work/application-source/source.json", packet);
  await applicationOutput("source_attempt", execution.run_attempt);
  await applicationOutput("known_runs", JSON.stringify(registration.known_run_ids));
}

/** Reproduce the maintained off-main version child in the secret-free compiler.
 * No remote ref is pushed and no candidate hooks are executed by preparation. */
async function prepareCompiler() {
  if (process.env.PORTCOVE_PREPARED_SOURCE === process.env.PORTCOVE_ORIGINAL_SOURCE) {
    assert.equal(process.env.PORTCOVE_APPLICATION_PACKAGE_MODE, "qualification");
    return;
  }
  const classification: unknown = JSON.parse(process.env.PORTCOVE_CLASSIFICATION ?? "null");
  const history: unknown = JSON.parse(process.env.PORTCOVE_PUBLISHED_VERSIONS ?? "null");
  const prepared = await prepareReleaseVersion(process.cwd(), classification, history);
  assert.equal(prepared.prepared_commit, process.env.PORTCOVE_PREPARED_SOURCE);
  assert.equal(prepared.prepared_tree, process.env.PORTCOVE_PREPARED_TREE);
  execFileSync(
    "git",
    ["-c", "core.hooksPath=NUL", "checkout", "--detach", prepared.prepared_commit],
    { timeout: 30000, stdio: "pipe" },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "select") await selectForQualification();
  else if (command === "wake-qualification")
    console.log(JSON.stringify(await readCurrentApplicationWakeQualification()));
  else if (command === "prepare") await prepare();
  else if (command === "bootstrap") await bootstrap();
  else if (command === "recover") await recoverImmutableFeed();
  else if (command === "renew") await renewPublishedMetadata();
  else if (command === "renew-unserved") await renewUnservedMetadata();
  else if (command === "recover-metadata") await recoverImmutableMetadataFeed();
  else if (command === "prepare-compiler") await prepareCompiler();
  else if (command === "inspect") {
    const raw = await readApplicationJson("work/application-source/source.json");
    assert.ok(isRecord(raw));
    console.log(JSON.stringify({ authority: "none", source: raw.original_source }));
  } else throw new Error("unknown fixed application source operation");
}
