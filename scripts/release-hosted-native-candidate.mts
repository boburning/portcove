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
} from "./release-native-candidate.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import {
  recoverRemoteCoordinator,
  hydrateRetainedCoordinatorOperation,
} from "./release-coordinator-recovery.mts";
import { inspectCompactCapacityOperations } from "./release-capacity.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  withReadOnlyReleaseChildren,
  readOnlyReleaseChildEnvironment,
  bindReadOnlyReleaseChildren,
} from "./release-readonly-child-environment.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
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
  const deadline = Math.min(parent.deadline, performance.now() + 15 * 60 * 1000);
  const remaining = (maximum: number) => {
    parent.recheck();
    const left = Math.floor(Math.min(maximum, deadline - performance.now()));
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
  return { parent, deadline, remaining, api, download, recover };
}

export async function acquireActualHostedNativeCandidate(parentReceipt: object) {
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
    return await withReadOnlyReleaseChildren(directory, async () => {
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
            release_profile: "initial-beta-win-linux",
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
      await writeFile(path.join(directory, "selection.json"), record, { flag: "wx", mode: 0o600 });
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
    });
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
    return await withReadOnlyReleaseChildren(directory, async () => {
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
    });
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
