import { nativePlatformsForReleaseProfile } from "./release-package-policy.mts";
import { applicationReleaseProfile } from "./release-authority-configuration-contract.mts";
/** Original hosted-parent candidate custody. This selects bytes through the
 * existing collector; it cannot supply a native receipt or admission result. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  acquireHostedNativePreparation,
  type PreparedReleaseAdmissionFacts,
} from "./acquire-release-admission.mts";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import {
  inspectSelectedNativeCandidate,
  inspectHostedNativePreparationStage,
  inspectNativeSourceCommand,
  inspectNativePostSignController,
  inspectNativePostSignArtifactInventory,
  inspectNativePostSignPackageMetadata,
  inspectNativePredecessorReleaseAsset,
} from "./release-native-candidate.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { readGitHubArtifactArchive, readGitHubReleaseAsset } from "./github-binary.mts";
import {
  recoverRemoteCoordinator,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import { inspectCompactCapacityOperations } from "./release-capacity.mts";
import {
  withCoordinatorDeadline,
  coordinatorCommandTimeout,
} from "./release-coordinator-deadline.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  withReadOnlyReleaseChildren,
  readOnlyReleaseChildEnvironment,
  bindReadOnlyReleaseChildren,
} from "./release-readonly-child-environment.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { discoverReleaseArtifactFiles } from "./release-artifact-archive.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { deriveHostedNativePublicationJourneys } from "./release-native-publication-admission.mts";
import { inspectSelectedPublicationAuthorityConfiguration } from "./release-authority-configuration.mts";

import { retainNativeSourceDeclarations } from "./release-native-source-provider.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Selected = {
  facts: Readonly<PreparedReleaseAdmissionFacts>;
  identity: Awaited<ReturnType<typeof inspectSelectedNativeCandidate>>;
  bytes: Buffer;
};
const attempted = new WeakSet<object>();
const candidates = new WeakMap<
  object,
  {
    parent: object;
    snapshot: string;
    directory: string;
    selection: Selected;
    record: Buffer;
    recover: () => ReturnType<typeof recoverRemoteCoordinator>;
    stopped: boolean;
    readDeclarations: () => ReturnType<typeof retainNativeSourceDeclarations>;
  }
>();

async function hostedNativeSourceTransport(parentReceipt: object, directory: string) {
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
  const deadline = parent.deadline;
  const remaining = (maximum: number) => {
    parent.recheck();
    const left = Math.floor(
      Math.min(coordinatorCommandTimeout(maximum), deadline - performance.now()),
    );
    if (left < 1) throw new Error("original hosted native acquisition lifetime exhausted");
    return left;
  };
  const childEnvironment = readOnlyReleaseChildEnvironment();
  if (!childEnvironment) throw new Error("fixed hosted native reader environment absent");
  const spawn: NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]> = (
    command,
    args,
    options,
  ) => {
    if (command !== "gh") throw new Error("fixed hosted native source executable differs");
    inspectNativeSourceCommand(args, options.input);
    const result = spawnSync(command, args, {
      ...options,
      timeout: remaining(options.timeout ?? 15000),
      env: childEnvironment,
    });
    remaining(1);
    return result;
  };
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({ cwd: directory, maxBuffer: 2 * 1024 * 1024, spawn })(
      [...args, "--hostname", "github.com"],
      input,
    ),
  );
  const download: typeof readGitHubArtifactArchive = (endpoint, options) =>
    readGitHubArtifactArchive(endpoint, {
      ...options,
      spawn: (command, args, settings) => {
        if (command !== "gh") throw new Error("fixed hosted native source executable differs");
        inspectNativeSourceCommand(args);
        const result = spawnSync(command, args, {
          ...settings,
          env: childEnvironment,
          timeout: remaining(settings.timeout ?? 60000),
        });
        remaining(1);
        return result;
      },
    });
  const downloadAsset: typeof readGitHubReleaseAsset = (endpoint, options) =>
    readGitHubReleaseAsset(endpoint, {
      ...options,
      spawn: (command, args, settings) => {
        if (command !== "gh") throw new Error("fixed hosted native source executable differs");
        inspectNativeSourceCommand(args);
        const result = spawnSync(command, args, {
          ...settings,
          env: childEnvironment,
          timeout: remaining(settings.timeout ?? 60000),
        });
        remaining(1);
        return result;
      },
    });
  const recover = bindReadOnlyReleaseChildren(async () => {
    await requireActualHostedNativeParentSource(parentReceipt);
    remaining(1);
    const current = await recoverRemoteCoordinator(
      directory,
      { schema_version: 1, namespace: parent.configuration.journal.namespace },
      { transport: { cwd: directory, spawn, deadline } },
    );
    await requireActualHostedNativeParentSource(parentReceipt);
    remaining(1);
    return current;
  });
  return { parent, deadline, remaining, api, download, downloadAsset, recover };
}

export async function acquireActualHostedNativeCandidate(parentReceipt: object) {
  const acquisitionDeadline = performance.now() + 15 * 60 * 1000;
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
  if (parent.stage !== "payload-signing" || attempted.has(parentReceipt))
    throw new Error(
      "one original pre-sign hosted native acquisition required; retain and reconcile",
    );
  attempted.add(parentReceipt);
  const directory = await mkdtemp(path.join(parent.directory, "candidate-"));
  await chmod(directory, 0o700);
  let phase = "reserved-source";
  try {
    return await withCoordinatorDeadline(Math.min(acquisitionDeadline, parent.deadline), () =>
      withReadOnlyReleaseChildren(directory, async () => {
        const { remaining, api, download, recover } = await hostedNativeSourceTransport(
          parentReceipt,
          directory,
        );
        const before = await recover();
        if (inspectHostedNativePreparationStage(before.input) !== "payload-signing")
          throw new Error("original reservation is not at the native pre-sign stage");
        phase = "immutable-acquisition";
        let retained: {
          identity: { platform_label: string; filename: string; bytes: number; sha256: string };
          bytes: Buffer;
        } | null = null;
        let selected: Selected | null = null;
        try {
          await acquireHostedNativePreparation(
            parentReceipt,
            directory,
            {
              schema_version: 2,
              namespace: parent.configuration.journal.namespace,
              release_profile: applicationReleaseProfile(parent.configuration),
            },
            {
              api,
              download,
              recover,
              retainDesktopPackage: async (identity, bytes) => {
                await requireActualHostedNativeParentSource(parentReceipt);
                if (identity.platform_label !== parent.platform_label) return;
                if (retained) throw new Error("hosted native package repeats");
                retained = { identity: structuredClone(identity), bytes };
              },
            },
            async (facts) => {
              await requireActualHostedNativeParentSource(parentReceipt);
              if (!retained || facts.checkpoint !== before.checkpoint)
                throw new Error("hosted native package or frozen reservation differs");
              const identity = await inspectSelectedNativeCandidate(
                facts,
                parent.platform_label,
                retained,
              );
              selected = { facts, identity, bytes: retained.bytes };
              // Deliberate refusal at the existing pair gate. These acquired facts
              // do not contain native acceptance and cannot become admission.
            },
          );
          throw new Error("hosted native acquisition unexpectedly passed admission");
        } catch (error) {
          if (
            !selected ||
            !(error instanceof CoordinatorRemoteError) ||
            !isRecord(error.evidence) ||
            error.evidence.phase !== "actual-stage-native-qualification"
          )
            throw error;
        }
        const selection = selected as Selected;
        const current = await recover();
        if (
          current.checkpoint !== before.checkpoint ||
          selection.facts.checkpoint !== current.checkpoint ||
          inspectHostedNativePreparationStage(current.input) !== "payload-signing"
        )
          throw new Error("hosted native reservation changed during acquisition");
        phase = "candidate-retention";
        const record = Buffer.from(
          JSON.stringify({
            schema_version: 1,
            checkpoint: current.checkpoint,
            platform_label: parent.platform_label,
            candidate: selection.identity.candidate,
            version: selection.identity.version,
            facts_sha256: releaseCanonicalDigest(selection.facts),
            authority: "none",
          }),
        );
        if (record.length > 8192) throw new Error("hosted native selection record exceeds bound");
        await writeFile(path.join(directory, "package.bin"), selection.bytes, {
          flag: "wx",
          mode: 0o600,
        });
        await writeFile(path.join(directory, "selection.json"), record, {
          flag: "wx",
          mode: 0o600,
        });
        await requireActualHostedNativeParentSource(parentReceipt);
        remaining(1);
        const receipt = Object.freeze({
          kind: "hosted-native-candidate",
          directory,
          platform_label: parent.platform_label,
          stage: parent.stage,
          authority: "none",
          native_acceptance: "not-established",
        });
        candidates.set(receipt, {
          parent: parentReceipt,
          snapshot: JSON.stringify(receipt),
          directory,
          selection,
          record,
          recover,
          readDeclarations: bindReadOnlyReleaseChildren(async () => {
            await requireActualHostedNativeParentSource(parentReceipt);
            remaining(1);
            const declaration = await retainNativeSourceDeclarations(directory, (pathname) =>
              api.request(
                "GET",
                `repos/boburning/portcove/contents/${pathname}?ref=${selection.identity.candidate.source_commit}`,
              ),
            );
            await requireActualHostedNativeParentSource(parentReceipt);
            remaining(1);
            return declaration;
          }),
          stopped: false,
        });
        return receipt;
      }),
    );
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        phase,
        automatic_retry: false,
        authority: "none",
        native_acceptance: "not-established",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`hosted native acquisition refused; retain ${directory}`);
  }
}

export async function requireActualHostedNativeCandidate(receipt: object) {
  const retained = candidates.get(receipt);
  if (!retained || retained.stopped || retained.snapshot !== JSON.stringify(receipt))
    throw new Error("original active hosted native candidate required");
  try {
    const parent = await requireActualHostedNativeParentSource(retained.parent);
    const record = await readControllerToolFile(
      path.join(retained.directory, "selection.json"),
      retained.record.length,
    );
    const bytes = await readControllerToolFile(
      path.join(retained.directory, "package.bin"),
      retained.selection.identity.candidate.package.bytes,
    );
    if (
      !record.equals(retained.record) ||
      hash(bytes) !== retained.selection.identity.candidate.package.sha256
    )
      throw new Error("hosted native retained candidate changed");
    const current = await retained.recover();
    if (
      current.checkpoint !== retained.selection.facts.checkpoint ||
      inspectHostedNativePreparationStage(current.input) !== "payload-signing"
    )
      throw new Error("hosted native candidate reservation changed");
    await requireActualHostedNativeParentSource(retained.parent);
    if (!isRecord(current.input) || !isRecord(current.input.active_candidate))
      throw new Error("hosted native candidate recovery state absent");
    return Object.freeze({
      parent_source: retained.parent,
      directory: retained.directory,
      package_path: path.join(retained.directory, "package.bin"),
      candidate: structuredClone(retained.selection.identity.candidate),
      version: retained.selection.identity.version,
      facts: structuredClone(retained.selection.facts),
      checkpoint: current.checkpoint,
      recovery: {
        transient_retries: current.input.active_candidate.transient_retries,
        substantive_repairs: current.input.active_candidate.substantive_repairs,
      },
      platform_label: parent.platform_label,
      stage: parent.stage,
      authority: "none" as const,
      native_acceptance: "not-established" as const,
    });
  } catch (error) {
    retained.stopped = true;
    throw error;
  }
}

/** Only the original hosted acquisition owns this fixed immutable-source reader.
 * Declarations remain distinct from loaded native runtime observations. */
export async function readActualHostedNativeSourceDeclarations(receipt: object) {
  const retained = candidates.get(receipt);
  if (!retained) throw new Error("original hosted native candidate required");
  try {
    const selected = await requireActualHostedNativeCandidate(receipt);
    const declaration = await retained.readDeclarations();
    await requireActualHostedNativeCandidate(receipt);
    return Object.freeze({
      declaration,
      candidate: selected.candidate,
      authority: "none" as const,
      scope: "actual candidate source reads; declarations only, no native acceptance",
    });
  } catch (error) {
    retained.stopped = true;
    throw error;
  }
}

const postSignAttempted = new WeakSet<object>();
const postSignSources = new WeakMap<
  object,
  {
    parent: object;
    directory: string;
    record: Buffer;
    checkpoint: string;
    candidate: Record<string, unknown>;
    controller: ReturnType<typeof inspectNativePostSignController>;
    source: Awaited<ReturnType<typeof hostedNativeSourceTransport>>;
    stopped: boolean;
  }
>();

/** Read-only original-parent join, not candidate/crypto/native acceptance. The
 * timestamp run is obtained from the authenticated coordinator, never supplied
 * by a caller or inferred from the compiler run. No operation is repeated. */
export async function readActualHostedNativePostSignController(parentReceipt: object) {
  const acquisitionDeadline = performance.now() + 15 * 60 * 1000;
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
  if (parent.stage !== "release-publication" || postSignAttempted.has(parentReceipt))
    throw new Error(
      "one original post-sign hosted native source required; explicit recovery required",
    );
  postSignAttempted.add(parentReceipt);
  const directory = await mkdtemp(path.join(parent.directory, "post-sign-source-"));
  await chmod(directory, 0o700);
  let phase = "timestamp-source";
  try {
    return await withCoordinatorDeadline(Math.min(acquisitionDeadline, parent.deadline), () =>
      withReadOnlyReleaseChildren(directory, async () => {
        const source = await hostedNativeSourceTransport(parentReceipt, directory);
        const before = await source.recover();
        const candidate = before.input.active_candidate;
        if (!isRecord(before.input.controller))
          throw new Error("original hosted coordinator source required");
        const capacity = before.input.controller.capacity_attempt;
        if (!isRecord(candidate) || !isRecord(capacity) || capacity.schema_version !== 2)
          throw new Error("original post-sign reservation and operation history required");
        const matches: {
          checkpoint: string;
          operation: unknown;
          controller: ReturnType<typeof inspectNativePostSignController>;
        }[] = [];
        const consider = (checkpoint: string, operation: unknown) => {
          try {
            const controller = inspectNativePostSignController(
              operation,
              candidate,
              parent.producer.controller_revision,
            );
            // Bind the original parent's revision/ref/run/attempt/actor. This is
            // not an explicit operation-to-parent grant-digest association.
            if (
              controller.controller_ref !== parent.producer.controller_ref ||
              controller.run_id !== parent.producer.run_id ||
              controller.run_attempt !== parent.producer.run_attempt ||
              !isRecord(operation) ||
              !isRecord(operation.executor_identity) ||
              operation.executor_identity.actor_id !== parent.producer.actor_id
            )
              throw new Error("timestamp executor differs from original native parent");
            matches.push({ checkpoint, operation, controller });
          } catch {
            // Unrelated completed operations do not appoint this source. Missing
            // or ambiguous matching success is refused below.
          }
        };
        const destination = `github-actions:boburning/portcove:${String(candidate.version)}:tuf-timestamp-envelope`;
        if (capacity.operation !== null) {
          const operation = capacity.operation;
          if (
            isRecord(operation) &&
            operation.destination === destination &&
            isRecord(operation.candidate) &&
            operation.candidate.prepared_commit === candidate.prepared_commit &&
            operation.candidate.transient_retries === candidate.transient_retries &&
            operation.candidate.substantive_repairs === candidate.substantive_repairs
          ) {
            // A pending/refused/ambiguous current effect cannot be hidden by an
            // older completed receipt. Its existing coordinator recovery is first.
            inspectNativePostSignController(
              operation,
              candidate,
              parent.producer.controller_revision,
            );
          }
          consider(before.checkpoint, operation);
        }
        phase = "retained-timestamp-history";
        const groups = inspectCompactCapacityOperations(capacity.prior_operations).filter(
          (group) =>
            group.subject.kind === "candidate" &&
            group.subject.identity === candidate.prepared_commit &&
            group.transient_retries === candidate.transient_retries &&
            group.substantive_repairs === candidate.substantive_repairs &&
            group.kind === "upload" &&
            group.destination_sha256 === releaseCanonicalDigest(destination),
        );
        for (const group of groups)
          for (const proof of group.attempts) {
            const operation = await withCoordinatorDeadline(source.deadline, () =>
              hydrateRetainedCoordinatorOperation(before.repository, proof, { api: source.api }),
            );
            await requireActualHostedNativeParentSource(parentReceipt);
            source.remaining(1);
            consider(proof.checkpoint, operation);
          }
        if (matches.length !== 1)
          throw new Error("exact original hosted timestamp source missing or ambiguous");
        const selected = matches[0]!;
        const after = await source.recover();
        if (
          after.checkpoint !== before.checkpoint ||
          releaseCanonicalDigest(after.input.active_candidate) !== releaseCanonicalDigest(candidate)
        )
          throw new Error("hosted post-sign reservation changed during source acquisition");
        phase = "source-retention";
        const record = Buffer.from(
          JSON.stringify({
            schema_version: 1,
            checkpoint: before.checkpoint,
            candidate,
            timestamp: selected,
            producer: parent.producer,
            configuration_sha256: releaseCanonicalDigest(parent.configuration),
            authority: "none",
            native_acceptance: "not-established",
          }),
        );
        if (record.length > 256 * 1024)
          throw new Error("hosted timestamp source exceeds retention bound");
        await writeFile(path.join(directory, "original-controller-selection.json"), record, {
          flag: "wx",
          mode: 0o600,
        });
        const receipt = Object.freeze({
          kind: "hosted-native-post-sign-controller-source",
          directory,
          authority: "none",
          native_acceptance: "not-established",
        });
        postSignSources.set(receipt, {
          parent: parentReceipt,
          directory,
          record,
          checkpoint: before.checkpoint,
          candidate: structuredClone(candidate),
          controller: selected.controller,
          source,
          stopped: false,
        });
        // Getter includes fresh source/retention/journal checks after the last
        // awaited write. No completed result is returned from expired custody.
        await requireActualHostedNativePostSignController(receipt);
        return receipt;
      }),
    );
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        phase,
        automatic_retry: false,
        recovery_required: true,
        authority: "none",
        native_acceptance: "not-established",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`hosted native post-sign source refused; retain ${directory}`);
  }
}

export async function requireActualHostedNativePostSignController(receipt: object) {
  const state = postSignSources.get(receipt);
  if (!state || state.stopped) throw new Error("original active hosted post-sign source required");
  try {
    const parent = await requireActualHostedNativeParentSource(state.parent);
    const record = await readControllerToolFile(
      path.join(state.directory, "original-controller-selection.json"),
      state.record.length,
    );
    if (!record.equals(state.record)) throw new Error("retained hosted timestamp source changed");
    const current = await state.source.recover();
    if (
      current.checkpoint !== state.checkpoint ||
      releaseCanonicalDigest(current.input.active_candidate) !==
        releaseCanonicalDigest(state.candidate)
    )
      throw new Error("hosted post-sign reservation advanced; explicit recovery required");
    await requireActualHostedNativeParentSource(state.parent);
    state.source.remaining(1);
    if (state.stopped) throw new Error("original hosted post-sign source stopped during readback");
    return Object.freeze({
      parent_source: state.parent,
      directory: state.directory,
      checkpoint: state.checkpoint,
      candidate: structuredClone(state.candidate),
      controller: structuredClone(state.controller),
      producer: parent.producer,
      configuration: parent.configuration,
      deadline: state.source.deadline,
      authority: "none" as const,
      native_acceptance: "not-established" as const,
      scope:
        "original parent/coordinator timestamp source only; signed context, package and capture pending" as const,
    });
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}

/** Fixed public source reads for the original post-sign session. Numeric IDs
 * are obtained from its own complete inventory, never accepted from a caller. */
export async function readActualHostedNativePostSignInventory(receipt: object) {
  const original = await requireActualHostedNativePostSignController(receipt);
  const state = postSignSources.get(receipt)!;
  try {
    const response = state.source.api.request(
      "GET",
      `repos/boburning/portcove/actions/runs/${original.controller.run_id}/artifacts?per_page=100`,
    );
    state.source.remaining(1);
    if (response.status !== 200) throw new Error("original signed artifact inventory unavailable");
    const inventory = inspectNativePostSignArtifactInventory(response.body, original.controller);
    await requireActualHostedNativePostSignController(receipt);
    return inventory;
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}

export async function readActualHostedNativePostSignContextArchive(receipt: object) {
  const inventory = await readActualHostedNativePostSignInventory(receipt);
  const state = postSignSources.get(receipt)!;
  try {
    const bytes = state.source.download(
      `repos/boburning/portcove/actions/artifacts/${inventory.context.id}/zip`,
      {
        cwd: state.directory,
        maxBytes: inventory.context.bytes,
        timeoutMs: state.source.remaining(30000),
      },
    );
    if (bytes.length !== inventory.context.bytes || hash(bytes) !== inventory.context.sha256)
      throw new Error("original signed context archive changed");
    const after = await readActualHostedNativePostSignInventory(receipt);
    if (releaseCanonicalDigest(after) !== releaseCanonicalDigest(inventory))
      throw new Error("original signed artifact inventory changed during context acquisition");
    return { inventory, bytes: Buffer.from(bytes) };
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}

const journeyAttempts = new WeakSet<object>();
const postSignJourneys = new WeakMap<
  object,
  {
    inputs: object;
    source: object;
    directory: string;
    record: Buffer;
    stopped: boolean;
    read: () => Promise<{
      inputs: Awaited<
        ReturnType<
          typeof import("./release-hosted-native-postsign-inputs.mts").requireActualHostedNativePostSignInputs
        >
      >;
      journey: unknown;
      predecessor_record: Record<string, unknown> | null;
    }>;
  }
>();

/** The original signed-input receipt appoints both context and source. Neither a
 * caller-supplied journey nor a publication-job principal can replace this join. */
export async function readActualHostedNativePostSignJourney(inputsReceipt: object) {
  const phaseDeadline = performance.now() + 120000;
  if (journeyAttempts.has(inputsReceipt))
    throw new Error("one original hosted journey attempt; explicit recovery required");
  journeyAttempts.add(inputsReceipt);
  const { requireActualHostedNativePostSignInputs } =
    await import("./release-hosted-native-postsign-inputs.mts");
  const inputs = await requireActualHostedNativePostSignInputs(inputsReceipt);
  const sourceReceipt = inputs.source_receipt;
  const original = postSignSources.get(sourceReceipt);
  if (!original) throw new Error("original hosted journey source absent");
  const deadline = Math.min(phaseDeadline, inputs.deadline);
  const active = () => {
    original.source.remaining(1);
    if (performance.now() >= deadline)
      throw new Error("hosted journey original deadline exhausted");
  };
  active();
  const directory = await mkdtemp(path.join(inputs.directory, "journey-"));
  await chmod(directory, 0o700);
  let phase = "original-source";
  try {
    return await withReadOnlyReleaseChildren(directory, async () => {
      const parent = await requireActualHostedNativeParentSource(original.parent);
      const current = await original.source.recover();
      active();
      if (parent.stage !== "release-publication" || current.checkpoint !== inputs.source.checkpoint)
        throw new Error("original hosted journey reservation differs");
      const configuration = inspectSelectedPublicationAuthorityConfiguration(parent.configuration);
      if (configuration.purpose !== "application")
        throw new Error("hosted application journey required");
      phase = "authenticated-context-files";
      const files = await readBoundedReleaseContextFiles(path.dirname(inputs.context.context));
      const identities = [...files]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
      if (
        releaseCanonicalDigest(identities) !== releaseCanonicalDigest(inputs.context.manifest.files)
      )
        throw new Error("original hosted context files changed");
      active();
      phase = "authenticated-predecessor-pair";
      if (typeof inputs.publication.repository_sha256 !== "string")
        throw new Error("original signed repository digest absent");
      const signedContextSha256 = inputs.publication.repository_sha256;
      const platforms = nativePlatformsForReleaseProfile(applicationReleaseProfile(configuration));
      const journeys = await withCoordinatorDeadline(deadline, () =>
        deriveHostedNativePublicationJourneys(
          {
            files,
            coordinator_input: current.input,
            manifest: inputs.context.manifest,
            namespace: configuration.journal.namespace,
            signed_context_sha256: signedContextSha256,
            platform_labels: platforms,
            public_pins: configuration.publication,
            authority_schema_version: configuration.schema_version,
            api: original.source.api,
          },
          directory,
          deadline,
          original.parent,
        ),
      );
      active();
      if (journeys.length !== platforms.length)
        throw new Error("complete hosted journey platform pair required");
      const journey =
        journeys[platforms.findIndex((platform) => platform === parent.platform_label)];
      if (!isRecord(journey)) throw new Error("original platform journey absent");
      let predecessorRecord: Record<string, unknown> | null = null;
      if (isRecord(journey.predecessor)) {
        const predecessor = journey.predecessor;
        if (!isRecord(predecessor.package)) throw new Error("original predecessor package absent");
        const predecessorPackage = predecessor.package;
        const records = [...files]
          .filter(([name]) => name.startsWith("prior/targets/"))
          .map(([, bytes]) => JSON.parse(bytes.toString("utf8")) as unknown)
          .filter(
            (record) =>
              isRecord(record) &&
              record.target === parent.platform_label &&
              record.source_commit === predecessor.source_commit &&
              record.source_tree === predecessor.source_tree &&
              isRecord(record.artifact) &&
              record.artifact.sha256 === predecessorPackage.sha256 &&
              record.artifact.bytes === predecessorPackage.bytes,
          );
        if (records.length !== 1 || !isRecord(records[0]))
          throw new Error("exact hosted predecessor record ambiguous");
        predecessorRecord = records[0];
      }
      phase = "journey-retention";
      const record = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          checkpoint: current.checkpoint,
          platform_label: parent.platform_label,
          journey,
          predecessor_record: predecessorRecord,
          repository_sha256: inputs.publication.repository_sha256,
          context_manifest_sha256: hash(Buffer.from(JSON.stringify(inputs.context.manifest))),
          authority: "none",
          native_acceptance: "not-established",
        }),
      );
      if (record.length > 131072) throw new Error("hosted journey receipt exceeds bound");
      await writeFile(path.join(directory, "journey.json"), record, { flag: "wx", mode: 0o600 });
      const state = {
        inputs: inputsReceipt,
        source: sourceReceipt,
        directory,
        record,
        stopped: false,
        read: bindReadOnlyReleaseChildren(async () => {
          original.source.remaining(1);
          const retained = await requireActualHostedNativePostSignInputs(inputsReceipt);
          const bytes = await readControllerToolFile(
            path.join(directory, "journey.json"),
            record.length,
          );
          if (
            !bytes.equals(record) ||
            retained.source_receipt !== sourceReceipt ||
            retained.publication.repository_sha256 !== inputs.publication.repository_sha256
          )
            throw new Error("original hosted journey custody changed");
          await requireActualHostedNativePostSignController(sourceReceipt);
          original.source.remaining(1);
          return {
            inputs: retained,
            journey: structuredClone(journey),
            predecessor_record: structuredClone(predecessorRecord),
          };
        }),
      };
      const receipt = Object.freeze({
        kind: "original-hosted-post-sign-journey",
        directory,
        authority: "none",
        native_acceptance: "not-established",
      });
      active();
      postSignJourneys.set(receipt, state);
      await requireActualHostedNativePostSignJourney(receipt);
      active();
      return receipt;
    });
  } catch {
    original.stopped = true;
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, automatic_retry: false, recovery_required: true, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`hosted journey refused; retain ${directory}`);
  }
}

export async function requireActualHostedNativePostSignJourney(receipt: object) {
  const state = postSignJourneys.get(receipt);
  if (!state || state.stopped) throw new Error("original active hosted journey receipt required");
  try {
    const value = await state.read();
    if (state.stopped) throw new Error("original hosted journey stopped during readback");
    return {
      ...value,
      directory: state.directory,
      inputs_receipt: state.inputs,
      authority: "none" as const,
      native_acceptance: "not-established" as const,
    };
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}

const postSignPackageAttempts = new WeakSet<object>();
const postSignPackages = new WeakMap<
  object,
  {
    journey: object;
    directory: string;
    record: Buffer;
    stopped: boolean;
    read: () => Promise<{
      parent_source: object;
      directory: string;
      package_path: string;
      candidate: Awaited<ReturnType<typeof inspectSelectedNativeCandidate>>["candidate"];
      version: string;
      facts: Pick<PreparedReleaseAdmissionFacts, "assembly" | "archives" | "checkpoint">;
      journey: unknown;
      predecessor_record: Record<string, unknown> | null;
      checkpoint: string;
      recovery: { transient_retries: unknown; substantive_repairs: unknown };
      platform_label: "windows-x86_64" | "linux-x86_64";
      stage: "release-publication";
      inputs_receipt: object;
      predecessor: { path: string; bytes: number; sha256: string; version: string } | null;
    }>;
  }
>();

/** Exact compiler package bytes from the original authenticated context. This
 * receipt is not payload-signature, native, aggregate or publication acceptance. */
export async function acquireActualHostedNativePostSignPackage(journeyReceipt: object) {
  if (postSignPackageAttempts.has(journeyReceipt))
    throw new Error("one original hosted post-sign package attempt; explicit recovery required");
  postSignPackageAttempts.add(journeyReceipt);
  const verified = await requireActualHostedNativePostSignJourney(journeyReceipt);
  const inputs = verified.inputs;
  const sourceReceipt = inputs.source_receipt;
  const original = postSignSources.get(sourceReceipt);
  if (!original) throw new Error("original hosted package source missing");
  const parent = await requireActualHostedNativeParentSource(original.parent);
  const platform = parent.platform_label;
  const directory = await mkdtemp(path.join(verified.directory, "package-"));
  await chmod(directory, 0o700);
  let phase = "authenticated-package-metadata";
  try {
    return await withReadOnlyReleaseChildren(directory, async () => {
      const facts = inputs.context.manifest.facts;
      if (!isRecord(facts) || !Array.isArray(facts.archives))
        throw new Error("original signed package facts absent");
      const archives = facts.archives.filter(
        (entry: unknown) => isRecord(entry) && entry.platform === platform,
      );
      if (
        archives.length !== 1 ||
        !isRecord(archives[0]) ||
        typeof archives[0].artifact_id !== "number"
      )
        throw new Error("one original signed platform archive required");
      const endpoint = `repos/boburning/portcove/actions/artifacts/${archives[0].artifact_id}`;
      const read = () => {
        original.source.remaining(1);
        const response = original.source.api.request("GET", endpoint);
        original.source.remaining(1);
        if (response.status !== 200) throw new Error("original signed package archive unavailable");
        return response.body;
      };
      const before = read();
      const metadata = await inspectNativePostSignPackageMetadata(facts, platform, before);
      phase = "bounded-package-acquisition";
      const archive = original.source.download(`${endpoint}/zip`, {
        cwd: directory,
        maxBytes: metadata.archive.bytes,
        timeoutMs: original.source.remaining(120000),
      });
      const retained: {
        value?: {
          identity: Selected["identity"]["candidate"]["package"] & { platform_label: string };
          bytes: Buffer;
        };
      } = {};
      await discoverReleaseArtifactFiles(
        archive,
        { bytes: metadata.archive.bytes, sha256: metadata.archive.sha256 },
        platform,
        {
          version: metadata.accepted.version,
          run_id: metadata.accepted.run_id,
          run_attempt: metadata.accepted.run_attempt,
          source_commit: metadata.accepted.source_commit,
        },
        {
          retainDesktopPackage: async (identity, bytes) => {
            if (retained.value) throw new Error("original signed updater package duplicated");
            retained.value = { identity: structuredClone(identity), bytes: Buffer.from(bytes) };
          },
        },
      );
      if (!retained.value) throw new Error("original signed updater package absent");
      const after = read();
      await inspectNativePostSignPackageMetadata(facts, platform, after);
      if (releaseCanonicalDigest(before) !== releaseCanonicalDigest(after))
        throw new Error("original signed package provider identity changed");
      const selectedFacts = {
        assembly: facts.assembly,
        archives: metadata.archives,
        checkpoint: inputs.source.checkpoint,
      };
      const identity = await inspectSelectedNativeCandidate(
        selectedFacts,
        platform,
        retained.value,
      );
      await requireActualHostedNativePostSignJourney(journeyReceipt);
      const current = await original.source.recover();
      if (
        current.checkpoint !== inputs.source.checkpoint ||
        !isRecord(current.input.active_candidate)
      )
        throw new Error("original signed package reservation changed");
      const recovery = {
        transient_retries: current.input.active_candidate.transient_retries,
        substantive_repairs: current.input.active_candidate.substantive_repairs,
      };
      phase = "immutable-predecessor-acquisition";
      let predecessor: { path: string; bytes: number; sha256: string; version: string } | null =
        null;
      if (isRecord(verified.journey) && isRecord(verified.journey.predecessor)) {
        const record = verified.predecessor_record;
        if (!record || typeof record.version !== "string")
          throw new Error("original predecessor release record absent");
        const releaseEndpoint = `repos/boburning/portcove/releases/tags/${encodeURIComponent(`v${record.version}`)}`;
        const readRelease = () => {
          original.source.remaining(1);
          const response = original.source.api.request("GET", releaseEndpoint);
          if (
            response.status !== 200 ||
            !isRecord(response.body) ||
            typeof response.body.id !== "number"
          )
            throw new Error("original predecessor release unavailable");
          const assets = original.source.api.paginateRest(
            `repos/boburning/portcove/releases/${response.body.id}/assets`,
            {
              identity: (item: unknown) => {
                if (!isRecord(item) || typeof item.id !== "number")
                  throw new Error("predecessor asset identity absent");
                return String(item.id);
              },
              label: "original native immutable predecessor assets",
            },
          );
          original.source.remaining(1);
          return { release: response.body, assets };
        };
        const before = readRelease();
        const asset = inspectNativePredecessorReleaseAsset(
          record,
          verified.journey.predecessor,
          before.release,
          before.assets,
        );
        const bytes = original.source.downloadAsset(
          `repos/boburning/portcove/releases/assets/${asset.id}`,
          { cwd: directory, maxBytes: asset.bytes, timeoutMs: original.source.remaining(120000) },
        );
        if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256)
          throw new Error("original immutable predecessor bytes differ");
        const after = readRelease();
        const repeated = inspectNativePredecessorReleaseAsset(
          record,
          verified.journey.predecessor,
          after.release,
          after.assets,
        );
        if (releaseCanonicalDigest(asset) !== releaseCanonicalDigest(repeated))
          throw new Error("original predecessor provider identity changed");
        const filename = path.join(directory, `predecessor-${asset.filename}`);
        await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
        predecessor = {
          path: filename,
          bytes: asset.bytes,
          sha256: asset.sha256,
          version: asset.version,
        };
      }
      phase = "package-retention";
      const packagePath = path.join(directory, identity.candidate.package.filename);
      await writeFile(packagePath, retained.value.bytes, { flag: "wx", mode: 0o600 });
      const record = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          candidate: identity.candidate,
          version: identity.version,
          checkpoint: current.checkpoint,
          recovery,
          platform_label: platform,
          metadata: after,
          predecessor,
          repository_sha256: inputs.publication.repository_sha256,
          authority: "none",
          native_acceptance: "not-established",
          signature_verification: "pending",
        }),
      );
      if (record.length > 131072) throw new Error("hosted package receipt exceeds bound");
      await writeFile(path.join(directory, "package.json"), record, { flag: "wx", mode: 0o600 });
      const state = {
        journey: journeyReceipt,
        directory,
        record,
        stopped: false,
        read: bindReadOnlyReleaseChildren(async () => {
          const currentJourney = await requireActualHostedNativePostSignJourney(journeyReceipt);
          const current = await original.source.recover();
          if (
            current.checkpoint !== inputs.source.checkpoint ||
            !isRecord(current.input.active_candidate) ||
            releaseCanonicalDigest({
              transient_retries: current.input.active_candidate.transient_retries,
              substantive_repairs: current.input.active_candidate.substantive_repairs,
            }) !== releaseCanonicalDigest(recovery)
          )
            throw new Error("original hosted post-sign package reservation changed");
          if (predecessor) {
            const bytes = await readControllerToolFile(predecessor.path, predecessor.bytes);
            if (bytes.length !== predecessor.bytes || hash(bytes) !== predecessor.sha256)
              throw new Error("original predecessor retained bytes changed");
          }
          const bytes = await readControllerToolFile(packagePath, identity.candidate.package.bytes);
          const recorded = await readControllerToolFile(
            path.join(directory, "package.json"),
            record.length,
          );
          if (
            bytes.length !== identity.candidate.package.bytes ||
            hash(bytes) !== identity.candidate.package.sha256 ||
            !recorded.equals(record)
          )
            throw new Error("original hosted post-sign package custody changed");
          await requireActualHostedNativePostSignJourney(journeyReceipt);
          return {
            parent_source: original.parent,
            directory,
            package_path: packagePath,
            candidate: structuredClone(identity.candidate),
            version: identity.version,
            facts: structuredClone(selectedFacts),
            journey: currentJourney.journey,
            predecessor_record: currentJourney.predecessor_record,
            checkpoint: current.checkpoint,
            recovery: structuredClone(recovery),
            platform_label: platform,
            stage: "release-publication" as const,
            inputs_receipt: verified.inputs_receipt,
            predecessor: structuredClone(predecessor),
          };
        }),
      };
      const receipt = Object.freeze({
        kind: "original-hosted-post-sign-package",
        directory,
        authority: "none",
        native_acceptance: "not-established",
        signature_verification: "pending",
      });
      postSignPackages.set(receipt, state);
      await requireActualHostedNativePostSignPackage(receipt);
      return receipt;
    });
  } catch {
    original.stopped = true;
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, automatic_retry: false, recovery_required: true, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`hosted signed package acquisition refused; retain ${directory}`);
  }
}

export async function requireActualHostedNativePostSignPackage(receipt: object) {
  const state = postSignPackages.get(receipt);
  if (!state || state.stopped) throw new Error("original active hosted post-sign package required");
  try {
    const value = await state.read();
    if (state.stopped) throw new Error("original hosted package stopped during readback");
    return {
      ...value,
      authority: "none" as const,
      native_acceptance: "not-established" as const,
      signature_verification: "pending" as const,
    };
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}

export async function readActualHostedNativePostSignSourceDeclarations(packageReceipt: object) {
  const selected = await requireActualHostedNativePostSignPackage(packageReceipt);
  const { requireActualHostedNativePostSignInputs } =
    await import("./release-hosted-native-postsign-inputs.mts");
  const inputs = await requireActualHostedNativePostSignInputs(selected.inputs_receipt);
  const original = postSignSources.get(inputs.source_receipt);
  if (!original) throw new Error("original post-sign source reader absent");
  return await withReadOnlyReleaseChildren(selected.directory, async () => {
    const declaration = await retainNativeSourceDeclarations(selected.directory, (pathname) => {
      original.source.remaining(1);
      return original.source.api.request(
        "GET",
        `repos/boburning/portcove/contents/${pathname}?ref=${selected.candidate.source_commit}`,
      );
    });
    await requireActualHostedNativePostSignPackage(packageReceipt);
    return Object.freeze({
      declaration,
      candidate: selected.candidate,
      authority: "none",
      scope: "actual candidate source reads; declarations only, no native acceptance",
    });
  });
}
