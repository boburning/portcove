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
} from "./release-native-candidate.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { recoverRemoteCoordinator } from "./release-coordinator-recovery.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  withReadOnlyReleaseChildren,
  readOnlyReleaseChildEnvironment,
  bindReadOnlyReleaseChildren,
} from "./release-readonly-child-environment.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

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
  }
>();

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
