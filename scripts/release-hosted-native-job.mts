/** Fixed original-process native pipeline and public upload handoff.
 * This does not dispatch a job, upload, admit a proof, or activate production. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import { prepareHostedNativeRuntime } from "./release-hosted-native-runtime.mts";
import { prepareActualHostedLinuxInstallation } from "./release-hosted-native-installation.mts";
import {
  acquireActualHostedNativeCandidate,
  readActualHostedNativePostSignController,
  readActualHostedNativePostSignJourney,
  acquireActualHostedNativePostSignPackage,
} from "./release-hosted-native-candidate.mts";
import {
  acquireActualHostedNativePostSignInputs,
  verifyActualHostedNativePostSignPayload,
} from "./release-hosted-native-postsign-inputs.mts";
import {
  prepareActualHostedNativeLinuxRequest,
  prepareActualHostedNativeLinuxPostSignRequest,
} from "./release-hosted-native-linux-request.mts";
import { captureActualHostedNativeLinuxInvocation } from "./release-hosted-native-linux-capture.mts";
import { prepareActualHostedLinuxNativeStageReport } from "./release-native-linux-report.mts";
import {
  signActualHostedLinuxNativeProof,
  requireActualHostedLinuxNativeProof,
  signActualHostedWindowsNativeProof,
  requireActualHostedWindowsNativeProof,
} from "./release-hosted-native-proof-producer.mts";
import { requireActualHostedWindowsStage } from "./release-hosted-native-windows-session.mts";
import { captureActualHostedNativeWindowsInvocation } from "./release-hosted-native-windows-capture.mts";
import { prepareActualHostedWindowsNativeStageReport } from "./release-native-pre-sign-report.mts";
import { readHostedNativeProofArtifact } from "./release-hosted-native-artifact.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const keys = ["subject", "report", "capture", "bundle"] as const;
type Platform = "linux-x86_64" | "windows-x86_64";
type Proof = Awaited<ReturnType<typeof requireActualHostedLinuxNativeProof>>;
const pending = new WeakMap<
  object,
  {
    platform: Platform;
    proof: object;
    ready: Buffer;
    original: Proof;
    attempted: boolean;
    stage: "payload-signing" | "release-publication";
  }
>();
async function retain(file: string, bytes: Buffer) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** All six existing producers stay in one trusted parent. No imported report,
 * callback, injected provider, alternate stage or selected platform is admitted.
 * The caller must allocate this work within the ratified workflow resources. */
export async function prepareActualHostedLinuxPreSignJob(
  parentDirectory: string,
  originalDeadline: number,
  runtimeInput?: { tools: object; executing_entry: string },
) {
  const runtimeTools = runtimeInput?.tools;
  const executingEntry = runtimeInput?.executing_entry;
  const parent = await createActualHostedNativeParentSource(
    parentDirectory,
    "linux-x86_64",
    "payload-signing",
    originalDeadline,
  );
  const runtime =
    runtimeTools === undefined
      ? undefined
      : await prepareHostedNativeRuntime(runtimeTools, parent, executingEntry!);
  if (runtimeTools !== undefined)
    await prepareActualHostedLinuxInstallation(parent, runtimeTools, runtime!);
  const candidate = await acquireActualHostedNativeCandidate(parent);
  const request = await prepareActualHostedNativeLinuxRequest(candidate);
  const capture = await captureActualHostedNativeLinuxInvocation(request, runtime);
  const report = await prepareActualHostedLinuxNativeStageReport(capture);
  const proof = await signActualHostedLinuxNativeProof(report);
  return prepareUpload(proof, "payload-signing", "linux-x86_64");
}

export async function prepareActualHostedLinuxPostSignJob(
  parentDirectory: string,
  originalDeadline: number,
  runtimeInput: { tools: object; executing_entry: string },
) {
  const parent = await createActualHostedNativeParentSource(
    parentDirectory,
    "linux-x86_64",
    "release-publication",
    originalDeadline,
  );
  const runtime = await prepareHostedNativeRuntime(
    runtimeInput.tools,
    parent,
    runtimeInput.executing_entry,
  );
  const source = await readActualHostedNativePostSignController(parent);
  const inputs = await acquireActualHostedNativePostSignInputs(source, runtimeInput.tools, runtime);
  const journey = await readActualHostedNativePostSignJourney(inputs);
  const candidate = await acquireActualHostedNativePostSignPackage(journey);
  const payload = await verifyActualHostedNativePostSignPayload(candidate);
  const request = await prepareActualHostedNativeLinuxPostSignRequest(payload);
  const capture = await captureActualHostedNativeLinuxInvocation(request, runtime);
  const report = await prepareActualHostedLinuxNativeStageReport(capture);
  const proof = await signActualHostedLinuxNativeProof(report);
  return prepareUpload(proof, "release-publication", "linux-x86_64");
}

/** Only the original Windows session can choose and execute its next stage. */
export async function prepareActualHostedWindowsStageJob(stageReceipt: object) {
  const stage = await requireActualHostedWindowsStage(stageReceipt);
  const capture = await captureActualHostedNativeWindowsInvocation(stageReceipt);
  const report = await prepareActualHostedWindowsNativeStageReport(capture);
  const proof = await signActualHostedWindowsNativeProof(report);
  return prepareUpload(proof, stage.kind, "windows-x86_64");
}
async function originalProof(proof: object, platform: Platform) {
  return platform === "linux-x86_64"
    ? requireActualHostedLinuxNativeProof(proof)
    : requireActualHostedWindowsNativeProof(proof);
}
async function prepareUpload(
  proof: object,
  stage: "payload-signing" | "release-publication",
  platform: Platform,
) {
  const original = await originalProof(proof, platform);
  assert.equal(original.stage, stage);
  const ready = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      name: original.artifact_name,
      files: keys.map((key) => ({
        path: path.join(original.directory, `${key}.json`),
        bytes: original.files[key].length,
        sha256: hash(original.files[key]),
      })),
      retention_days: 7,
      overwrite: false,
      compression_level: 0,
      authority: "none",
    }),
  );
  await retain(path.join(original.directory, "native-upload-ready.json"), ready);
  // Recheck after publication; a partially completed handoff is never retried.
  await originalProof(proof, platform);
  const receipt = Object.freeze({
    kind:
      platform === "linux-x86_64"
        ? stage === "payload-signing"
          ? "original-hosted-linux-pre-sign-upload"
          : "original-hosted-linux-post-sign-upload"
        : `original-hosted-windows-${stage}-upload`,
    authority: "none",
  });
  pending.set(receipt, { platform, proof, ready, original, attempted: false, stage });
  return {
    receipt,
    ready_file: path.join(original.directory, "native-upload-ready.json"),
    deadline: original.deadline,
    authority: "none" as const,
  };
}

/** Exactly one readback for the original upload attempt. An Action output is
 * correlation data only; complete provider inventory, archive bytes and every
 * member must match the live original proof. Refusal retains all partial effects
 * and requires explicit existing coordinator recovery, never another upload. */
export async function readBackActualHostedLinuxPreSignUpload(
  receipt: object,
  acknowledgement: unknown,
) {
  return readBackUpload(receipt, acknowledgement, "payload-signing", "linux-x86_64");
}
export function readBackActualHostedLinuxPostSignUpload(receipt: object, acknowledgement: unknown) {
  return readBackUpload(receipt, acknowledgement, "release-publication", "linux-x86_64");
}
export function readBackActualHostedWindowsPreSignUpload(
  receipt: object,
  acknowledgement: unknown,
) {
  return readBackUpload(receipt, acknowledgement, "payload-signing", "windows-x86_64");
}
export function readBackActualHostedWindowsPostSignUpload(
  receipt: object,
  acknowledgement: unknown,
) {
  return readBackUpload(receipt, acknowledgement, "release-publication", "windows-x86_64");
}
async function readBackUpload(
  receipt: object,
  acknowledgement: unknown,
  stage: "payload-signing" | "release-publication",
  platform: Platform,
) {
  const state = pending.get(receipt);
  if (!state || state.platform !== platform || state.attempted || state.stage !== stage)
    throw new Error("original native upload requires explicit recovery");
  state.attempted = true;
  let phase = "acknowledgement";
  try {
    assert.ok(isRecord(acknowledgement));
    assert.equal(Object.keys(acknowledgement).sort().join(","), "artifact_id,sha256");
    const artifactId = acknowledgement.artifact_id;
    const artifactSha256 = acknowledgement.sha256;
    assert.ok(Number.isSafeInteger(artifactId) && Number(artifactId) > 0);
    assert.ok(typeof artifactSha256 === "string" && /^[a-f0-9]{64}$/u.test(artifactSha256));
    const original = await originalProof(state.proof, platform);
    assert.equal(original.directory, state.original.directory);
    assert.ok(
      (
        await readControllerToolFile(
          path.join(original.directory, "native-upload-ready.json"),
          8192,
        )
      ).equals(state.ready),
    );
    const deadline = Math.min(original.deadline, performance.now() + 120000);
    const remaining = () => {
      const left = Math.floor(deadline - performance.now());
      assert.ok(left > 0, "original native upload deadline exhausted");
      return Math.min(left, 15000);
    };
    phase = "provider-readback";
    const result = await withReadOnlyReleaseChildren(original.directory, async () => {
      const api = new GitHubApiClient((args, input) =>
        createGitHubRunner({
          cwd: original.directory,
          timeoutMs: remaining(),
          maxBuffer: 2 * 1024 * 1024,
        })(args, input),
      );
      return readHostedNativeProofArtifact(
        api,
        {
          controller_revision: original.producer.controller_revision,
          run_id: original.producer.run_id,
          run_attempt: original.producer.run_attempt,
          platform_label: platform,
          stage,
        },
        original.directory,
        deadline,
      );
    });
    assert.equal(result.artifact.id, artifactId);
    assert.equal(result.artifact.sha256, artifactSha256);
    assert.equal(result.locator.job_id, original.producer.job_id);
    assert.equal(result.locator.check_run_id, original.producer.check_run_id);
    for (const key of keys)
      assert.ok(
        result.files[key].equals(original.files[key]),
        "uploaded native proof differs from original capture",
      );
    await originalProof(state.proof, platform);
    remaining();
    const readback = {
      schema_version: 1,
      artifact: result.artifact,
      locator: result.locator,
      provider_bytes_match: true,
      native_acceptance: "not-established",
      authority: "none",
    };
    await retain(
      path.join(original.directory, "native-upload-readback.json"),
      Buffer.from(JSON.stringify(readback)),
    );
    await originalProof(state.proof, platform);
    return readback;
  } catch {
    try {
      await retain(
        path.join(state.original.directory, "native-upload-refusal.json"),
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            phase,
            upload_effect: "unknown",
            automatic_retry: false,
            recovery_required: true,
            authority: "none",
          }),
        ),
      );
    } catch {
      /* Preserve the original marker and partial effects. */
    }
    throw new Error(
      `native upload refused at ${phase}; retain ${state.original.directory} and reconcile`,
    );
  }
}
