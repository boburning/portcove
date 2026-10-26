/** Fixed original-process native upload rendezvous. Public routing never grants
 * proof custody, execution, signing or admission authority. No automatic retry. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { retainReleaseRoutingMarker } from "./release-routing-marker.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const exact = (raw: unknown, keys: string): raw is Record<string, unknown> =>
  isRecord(raw) && Object.keys(raw).sort().join(",") === keys;
const requestName = "native-job-upload-request.json";
const ackName = "native-job-upload-ack.json";
type Stage = "payload-signing" | "release-publication";
type RuntimeInput = { tools: object; executing_entry: string };
async function ownedRoot(root: string) {
  assert.ok(path.isAbsolute(root) && path.normalize(root) === root);
  assert.equal(await realpath(root), root);
  const stat = await lstat(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  if (process.platform !== "win32") {
    assert.equal(stat.uid, process.getuid?.());
    assert.equal(stat.mode & 0o077, 0);
  }
}
function active(deadline: bigint) {
  assert.ok(process.hrtime.bigint() < deadline, "original native upload wait exhausted");
}
function inspectRequest(raw: unknown, root: string) {
  assert.ok(exact(raw, "authority,deadline_ns,nonce,ready_file,ready_sha256,schema_version"));
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.authority, "none");
  assert.ok(typeof raw.nonce === "string" && /^[a-f0-9]{32}$/u.test(raw.nonce));
  assert.ok(typeof raw.ready_sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.ready_sha256));
  assert.ok(typeof raw.deadline_ns === "string" && /^[1-9][0-9]{0,19}$/u.test(raw.deadline_ns));
  const deadline = BigInt(raw.deadline_ns);
  active(deadline);
  assert.ok(typeof raw.ready_file === "string");
  const relative = path.relative(root, raw.ready_file);
  assert.ok(
    relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative),
  );
  assert.equal(path.basename(raw.ready_file), "native-upload-ready.json");
  return { nonce: raw.nonce, ready_file: raw.ready_file, ready_sha256: raw.ready_sha256, deadline };
}

/** Actions reads this fixed request, then performs one pinned upload. Inputs
 * remain bounded fixed public files; importing this request cannot mint a proof. */
export async function readHostedNativeUploadRequest(root: string) {
  return readUploadRequest(root, "payload-signing");
}
export async function readHostedNativePostSignUploadRequest(root: string) {
  return readUploadRequest(root, "release-publication");
}
async function readUploadRequest(root: string, stage: Stage) {
  await ownedRoot(root);
  const bytes = await readControllerToolFile(path.join(root, requestName), 4096);
  const request = inspectRequest(JSON.parse(bytes.toString("utf8")), root);
  const directory = path.dirname(request.ready_file);
  assert.equal(await realpath(directory), directory);
  await ownedRoot(directory);
  const readyBytes = await readControllerToolFile(request.ready_file, 8192);
  assert.equal(hash(readyBytes), request.ready_sha256);
  const ready: unknown = JSON.parse(readyBytes.toString("utf8"));
  assert.ok(
    exact(ready, "authority,compression_level,files,name,overwrite,retention_days,schema_version"),
  );
  assert.equal(ready.schema_version, 1);
  assert.equal(ready.authority, "none");
  assert.equal(ready.retention_days, 7);
  assert.equal(ready.overwrite, false);
  assert.equal(ready.compression_level, 0);
  assert.ok(
    typeof ready.name === "string" &&
      new RegExp(`^hosted-native-${stage}-linux-x86_64-[1-9][0-9]*-1$`, "u").test(ready.name),
  );
  assert.ok(Array.isArray(ready.files) && ready.files.length === 4);
  const files: string[] = [];
  for (const [index, name] of ["subject", "report", "capture", "bundle"].entries()) {
    const file: unknown = ready.files[index];
    assert.ok(exact(file, "bytes,path,sha256"));
    assert.equal(file.path, path.join(directory, `${name}.json`));
    assert.ok(
      Number.isSafeInteger(file.bytes) && Number(file.bytes) > 0 && Number(file.bytes) <= 131073,
    );
    assert.ok(typeof file.sha256 === "string" && /^[a-f0-9]{64}$/u.test(file.sha256));
    const payload = await readControllerToolFile(String(file.path), 131073);
    assert.equal(payload.length, file.bytes);
    assert.equal(hash(payload), file.sha256);
    files.push(String(file.path));
  }
  active(request.deadline);
  return {
    request_sha256: hash(bytes),
    nonce: request.nonce,
    deadline_ns: String(request.deadline),
    name: ready.name,
    files,
    retention_days: 7 as const,
    overwrite: false as const,
    compression_level: 0 as const,
    authority: "none" as const,
  };
}

/** Exactly one no-replace acknowledgement. Provider IDs/digests are correlation
 * data; only original-process provider readback can establish matching bytes. */
export async function acknowledgeHostedNativeUpload(
  root: string,
  requestSha256: string,
  artifactId: number,
  sha256: string,
) {
  return acknowledgeUpload(root, requestSha256, artifactId, sha256, "payload-signing");
}
export async function acknowledgeHostedNativePostSignUpload(
  root: string,
  requestSha256: string,
  artifactId: number,
  sha256: string,
) {
  return acknowledgeUpload(root, requestSha256, artifactId, sha256, "release-publication");
}
async function acknowledgeUpload(
  root: string,
  requestSha256: string,
  artifactId: number,
  sha256: string,
  stage: Stage,
) {
  assert.ok(/^[a-f0-9]{64}$/u.test(requestSha256));
  assert.ok(Number.isSafeInteger(artifactId) && artifactId > 0);
  assert.ok(/^[a-f0-9]{64}$/u.test(sha256));
  const request = await readUploadRequest(root, stage);
  assert.equal(request.request_sha256, requestSha256);
  await retainReleaseRoutingMarker(path.join(root, ackName), {
    schema_version: 1,
    request_sha256: requestSha256,
    nonce: request.nonce,
    artifact_id: artifactId,
    sha256,
    authority: "none",
  });
  active(BigInt(request.deadline_ns));
}

/** The original private receipt stays in this process across the Actions upload
 * and its readback. A new process or copied routing data cannot resume it. */
export async function runActualHostedLinuxNativeJob(
  root: string,
  originalDeadline: number,
  runtimeInput?: RuntimeInput,
) {
  return runNativeJob(root, originalDeadline, "payload-signing", runtimeInput);
}
export async function runActualHostedLinuxPostSignJob(
  root: string,
  originalDeadline: number,
  runtimeInput: RuntimeInput,
) {
  assert.ok(runtimeInput && typeof runtimeInput.executing_entry === "string");
  return runNativeJob(root, originalDeadline, "release-publication", runtimeInput);
}
async function runNativeJob(
  root: string,
  originalDeadline: number,
  stage: Stage,
  runtimeInput?: RuntimeInput,
) {
  await ownedRoot(root);
  assert.ok(Number.isFinite(originalDeadline) && originalDeadline > performance.now());
  // Claim the attempt before any producer can create effects. Existing state
  // is retained and requires coordinator recovery, never a second preparation.
  await retainReleaseRoutingMarker(path.join(root, "native-job-started.json"), {
    schema_version: 1,
    automatic_retry: false,
    authority: "none",
  });
  let phase = "preparation";
  try {
    // Only the original attested worker loads the bundled signing producer.
    // Source-only Actions request/ack readers have no dependency installation
    // and must not import that producer merely to inspect public routing.
    const {
      prepareActualHostedLinuxPreSignJob,
      readBackActualHostedLinuxPreSignUpload,
      prepareActualHostedLinuxPostSignJob,
      readBackActualHostedLinuxPostSignUpload,
    } = await import("./release-hosted-native-job.mts");
    const upload =
      stage === "payload-signing"
        ? await prepareActualHostedLinuxPreSignJob(root, originalDeadline, runtimeInput)
        : await prepareActualHostedLinuxPostSignJob(root, originalDeadline, runtimeInput!);
    phase = "upload-request";
    // Anchor before any awaited readiness read. The private proof's captured
    // deadline can be earlier; neither a read nor a new Actions step renews it.
    const monotonicOrigin = process.hrtime.bigint();
    const remaining = Math.min(
      120000,
      originalDeadline - performance.now(),
      upload.deadline - performance.now(),
    );
    assert.ok(remaining > 0);
    const deadline = monotonicOrigin + BigInt(Math.floor(remaining * 1e6));
    const request = {
      schema_version: 1,
      nonce: randomBytes(16).toString("hex"),
      ready_file: upload.ready_file,
      ready_sha256: hash(await readControllerToolFile(upload.ready_file, 8192)),
      deadline_ns: String(deadline),
      authority: "none",
    };
    inspectRequest(request, root);
    await retainReleaseRoutingMarker(path.join(root, requestName), request);
    active(deadline);
    const expected = await readUploadRequest(root, stage);
    phase = "upload-acknowledgement";
    let acknowledgement: unknown;
    while (acknowledgement === undefined) {
      active(deadline);
      try {
        acknowledgement = JSON.parse(
          (await readControllerToolFile(path.join(root, ackName), 2048)).toString("utf8"),
        );
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        await delay(100);
      }
    }
    active(deadline);
    assert.ok(
      exact(acknowledgement, "artifact_id,authority,nonce,request_sha256,schema_version,sha256"),
    );
    assert.equal(acknowledgement.schema_version, 1);
    assert.equal(acknowledgement.authority, "none");
    assert.equal(acknowledgement.nonce, expected.nonce);
    assert.equal(acknowledgement.request_sha256, expected.request_sha256);
    phase = "provider-readback";
    const readBack =
      stage === "payload-signing"
        ? readBackActualHostedLinuxPreSignUpload
        : readBackActualHostedLinuxPostSignUpload;
    const result = await readBack(upload.receipt, {
      artifact_id: acknowledgement.artifact_id,
      sha256: acknowledgement.sha256,
    });
    active(deadline);
    await retainReleaseRoutingMarker(path.join(root, "native-job-settlement.json"), {
      schema_version: 1,
      exit_code: 0,
      provider_bytes_match: true,
      native_acceptance: "not-established",
      authority: "none",
    });
    active(deadline);
    return result;
  } catch {
    try {
      await retainReleaseRoutingMarker(path.join(root, "native-job-refusal.json"), {
        schema_version: 1,
        phase,
        upload_effect: "unknown",
        automatic_retry: false,
        recovery_required: true,
        authority: "none",
      });
      await retainReleaseRoutingMarker(path.join(root, "native-job-settlement.json"), {
        schema_version: 1,
        exit_code: 1,
        phase,
        upload_effect: "unknown",
        automatic_retry: false,
        recovery_required: true,
        authority: "none",
      });
    } catch {
      /* Retain an earlier settlement and every partial effect. */
    }
    throw new Error(`native job refused at ${phase}; retain ${root} and use coordinator recovery`);
  }
}

/** The fixed bundle re-verifies its own source-bound tools in this process.
 * A private receipt from the bootstrap's separately bundled module is not used. */
export async function runConfiguredHostedLinuxNativeJob(
  raw: unknown,
  root: string,
  deadline: number,
  executingEntry: string,
) {
  return runConfiguredJob(raw, root, deadline, executingEntry, "payload-signing");
}
export async function runConfiguredHostedLinuxPostSignJob(
  raw: unknown,
  root: string,
  deadline: number,
  executingEntry: string,
) {
  return runConfiguredJob(raw, root, deadline, executingEntry, "release-publication");
}
async function runConfiguredJob(
  raw: unknown,
  root: string,
  deadline: number,
  executingEntry: string,
  stage: Stage,
) {
  const input: unknown = structuredClone(raw);
  assert.ok(exact(input, "tools") && exact(input.tools, "artifact,bundle"));
  assert.ok(isRecord(input.tools.artifact) && isRecord(input.tools.bundle));
  assert.ok(Number.isFinite(deadline) && performance.now() < deadline);
  const tools = await receiveControllerTools(
    root,
    input.tools.artifact as unknown as ControllerToolArtifactExpected,
    input.tools.bundle as unknown as { artifact_id: number; sha256: string },
    { deadline },
  );
  assert.ok(performance.now() < deadline);
  return runNativeJob(root, deadline, stage, { tools, executing_entry: executingEntry });
}

/** Preparation stays in the authenticated bundle's realm. Serialized reports
 * cannot reproduce the original tools/parent/runtime capabilities. */
export async function prepareConfiguredHostedWindowsRuntime(
  raw: unknown,
  root: string,
  deadline: number,
  executingEntry: string,
) {
  assert.ok(process.platform === "win32" && process.arch === "x64");
  const input: unknown = structuredClone(raw);
  assert.ok(exact(input, "tools") && exact(input.tools, "artifact,bundle"));
  assert.ok(isRecord(input.tools.artifact) && input.tools.artifact.platform === "windows-x86_64");
  assert.ok(isRecord(input.tools.bundle));
  assert.ok(
    Number.isFinite(deadline) &&
      deadline > performance.now() &&
      deadline - performance.now() <= 570000,
  );
  const { assertControllerBootstrapEnvironment } =
    await import("./release-controller-job-bootstrap.mts");
  assertControllerBootstrapEnvironment();
  await ownedRoot(root);
  const intent = path.join(root, "windows-runtime-preparation-intent.json");
  await writeFile(
    intent,
    JSON.stringify({
      schema_version: 1,
      platform: "windows-x86_64",
      automatic_retry: false,
      authority: "none",
    }),
    { flag: "wx", mode: 0o600, flush: true },
  );
  const initialCustody = inspectNativeRuntimeCustody([intent]);
  const active = () => {
    assertControllerBootstrapEnvironment();
    recheckNativeRuntimeCustody([intent], initialCustody);
    assert.ok(performance.now() < deadline, "original Windows preparation expired");
  };
  active();
  const tools = await receiveControllerTools(
    root,
    input.tools.artifact as unknown as ControllerToolArtifactExpected,
    input.tools.bundle as unknown as { artifact_id: number; sha256: string },
    { deadline },
  );
  active();
  const { createActualHostedNativeParentSource, requireActualHostedNativeParentSource } =
    await import("./release-hosted-native-parent.mts");
  const { prepareHostedNativeRuntime, requireHostedNativeRuntime } =
    await import("./release-hosted-native-runtime.mts");
  const parent = await createActualHostedNativeParentSource(
    root,
    "windows-x86_64",
    "payload-signing",
    deadline,
  );
  active();
  const original = await requireActualHostedNativeParentSource(parent);
  const evidenceFiles = ["source.json", "configuration.json", "identity.json"].map((name) =>
    path.join(original.directory, name),
  );
  const evidenceCustody = inspectNativeRuntimeCustody(evidenceFiles);
  const runtime = await prepareHostedNativeRuntime(tools, parent, executingEntry);
  active();
  const paths = await verifiedControllerToolPaths(tools);
  assert.equal(paths.platform, "windows-x86_64");
  await requireHostedNativeRuntime(runtime, parent);
  const report = {
    schema_version: 1,
    platform: "windows-x86_64",
    producer: original.producer,
    manifest_sha256: hash(
      await readControllerToolFile(path.join(paths.root, "manifest.json"), 65536),
    ),
    scope: "original source/tool/runtime preparation only",
    candidate_isolation: "unproven",
    native_acceptance: "not-established",
    production_tool_acceptance: "not-established",
    authority: "none",
  };
  active();
  recheckNativeRuntimeCustody(evidenceFiles, evidenceCustody);
  await retainReleaseRoutingMarker(path.join(root, "windows-runtime-prepared.json"), report);
  await requireHostedNativeRuntime(runtime, parent);
  await requireActualHostedNativeParentSource(parent);
  active();
  recheckNativeRuntimeCustody(evidenceFiles, evidenceCustody);
  return Object.freeze({ tools, parent, runtime });
}

/** Fixed caller entry. The bootstrap must supply its original cross-process
 * monotonic deadline; the CLI neither creates nor renews a job budget. Actual
 * producer admission independently verifies the fixed source/job identity. */
async function main() {
  const temporary = process.env.RUNNER_TEMP;
  const rawDeadline = process.env.PORTCOVE_NATIVE_DEADLINE_NS;
  assert.ok(temporary && path.isAbsolute(temporary));
  assert.ok(rawDeadline && /^[1-9][0-9]{0,19}$/u.test(rawDeadline));
  const deadline = BigInt(rawDeadline);
  active(deadline);
  const remaining = Number(deadline - process.hrtime.bigint()) / 1e6;
  assert.ok(remaining > 0 && remaining <= 1900000);
  const operation = process.argv[2];
  assert.ok(
    operation &&
      [
        "run",
        "upload-request",
        "upload-ack",
        "run-post-sign",
        "upload-request-post-sign",
        "upload-ack-post-sign",
      ].includes(operation),
    "fixed native operation required",
  );
  const postSign = operation.endsWith("-post-sign");
  const selected = postSign ? operation.slice(0, -"-post-sign".length) : operation;
  const root = path.join(
    temporary,
    postSign ? "portcove-native-linux-post-sign" : "portcove-native-linux-pre-sign",
  );
  if (selected === "run" && process.argv.length === 3) {
    await mkdir(root, { mode: 0o700 });
    active(deadline);
    const origin = performance.now();
    const configuration: unknown = JSON.parse(
      (
        await readControllerToolFile(path.join(temporary, "portcove-native-tool-input.json"), 8192)
      ).toString("utf8"),
    );
    active(deadline);
    const run = postSign ? runConfiguredHostedLinuxPostSignJob : runConfiguredHostedLinuxNativeJob;
    const result = await run(
      configuration,
      root,
      origin + Number(deadline - process.hrtime.bigint()) / 1e6,
      fileURLToPath(import.meta.url),
    );
    active(deadline);
    return result;
  }
  if (selected === "upload-request" && process.argv.length === 3) {
    for (;;) {
      active(deadline);
      try {
        const request = await readUploadRequest(
          root,
          postSign ? "release-publication" : "payload-signing",
        );
        active(deadline);
        return request;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        await delay(100);
      }
    }
  }
  if (selected === "upload-ack" && process.argv.length === 6) {
    assert.ok(/^[1-9][0-9]*$/u.test(process.argv[4] ?? ""));
    await acknowledgeUpload(
      root,
      process.argv[3]!,
      Number(process.argv[4]),
      process.argv[5]!,
      postSign ? "release-publication" : "payload-signing",
    );
    active(deadline);
    return { acknowledgement_retained: true, authority: "none" };
  }
  throw new Error("fixed native run/upload-request/upload-ack operation required");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "fixed native caller refused; retain original attempt and use coordinator recovery",
      );
      process.exitCode = 2;
    });
