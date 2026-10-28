/** Selected B worker child only. A retains every original protected receipt. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  openSync,
  fstatSync,
  closeSync,
  writeFileSync,
  constants,
} from "node:fs";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectHostedWindowsHarnessBinding,
  inspectHostedWindowsWorkerRequest,
  inspectHostedWindowsWorkerAcknowledgment,
  hostedWindowsWorkerAbi,
  hostedWindowsDiagnosticWorkflowRef,
} from "./release-hosted-native-windows-worker-contract.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { isRecord } from "./runtime-values.mts";
import {
  windowsSourceSystemExecutables,
  inspectWindowsSourceSystemCustody,
  recheckWindowsSourceSystemCustody,
} from "./release-native-runtime-custody.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const hostedWindowsStageExecutionAuthorized = false;
export const hostedWindowsDiagnosticStageExecutionAuthorized = true;
export function readHostedWindowsWorkerAbi() {
  return {
    abi: hostedWindowsWorkerAbi,
    worker: "scripts/release-native-worker.mts",
    execution_authorized: hostedWindowsStageExecutionAuthorized,
    scope: "selected-source ABI information only; data only",
    authority: "none",
  };
}
function read(file: string, maximum: number, expected: string) {
  const before = lstatSync(file, { bigint: true });
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(maximum),
  );
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert.ok(
      opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.size === before.size &&
        opened.nlink === 1n,
    );
    bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true }),
      current = lstatSync(file, { bigint: true });
    for (const value of [after, current])
      assert.ok(
        before.dev === value.dev &&
          before.ino === value.ino &&
          before.size === value.size &&
          before.mtimeNs === value.mtimeNs &&
          before.ctimeNs === value.ctimeNs &&
          value.nlink === 1n,
      );
  } finally {
    closeSync(fd);
  }
  assert.equal(digest(bytes), expected);
  return bytes;
}
export async function runHostedWindowsWorkerStage(file: string, expected: string) {
  assert.ok(
    hostedWindowsStageExecutionAuthorized,
    "held hosted worker execution awaits separate authority",
  );
  return runWindowsWorkerStageMechanism(file, expected);
}
/** Fixed diagnostic observation lane only; creates no production stage receipt. */
export function readHostedWindowsDiagnosticWorkerAbi() {
  return {
    ...readHostedWindowsWorkerAbi(),
    execution_authorized: hostedWindowsDiagnosticStageExecutionAuthorized,
    scope: "separately held connected diagnostic worker only; data only",
  };
}
export async function runHostedWindowsDiagnosticWorkerStage(
  file: string,
  expected: string,
  workflowRef: string,
) {
  assert.ok(
    hostedWindowsDiagnosticStageExecutionAuthorized,
    "Connected diagnostic worker awaits exact separate authority",
  );
  assert.equal(
    workflowRef,
    hostedWindowsDiagnosticWorkflowRef,
    "Fixed diagnostic worker workflow ref required",
  );
  assert.ok(
    ["payload-signing", "release-publication"].some(
      (stage) =>
        path.resolve(file) ===
        path.join(
          root,
          "work/hosted-windows-connected-diagnostic/owner",
          stage,
          "capture/worker-input.json",
        ),
    ),
    "Fixed same-job diagnostic worker input required",
  );
  return runWindowsWorkerStageMechanism(file, expected);
}
async function runWindowsWorkerStageMechanism(file: string, expected: string) {
  assert.ok(process.platform === "win32" && process.arch === "x64");
  assert.ok(/^[a-f0-9]{64}$/u.test(expected));
  const started = performance.now();
  const request = inspectHostedWindowsWorkerRequest(
    JSON.parse(read(file, 32768, expected).toString("utf8")),
  );
  assert.equal(
    path.resolve(process.argv[1] ?? ""),
    path.join(root, "scripts/release-native-worker.mts"),
  );
  assert.equal(path.resolve(process.cwd()), path.resolve(root));
  read(path.join(root, "scripts/release-native-worker.mts"), 131072, request.worker_sha256);
  assert.equal(path.resolve(process.execPath).toLowerCase(), request.tools.node.path.toLowerCase());
  read(process.execPath, 128 * 1024 ** 2, request.tools.node.sha256);
  assert.equal(request.tools.git.path, windowsSourceSystemExecutables.git);
  assert.equal(request.tools.powershell.path, windowsSourceSystemExecutables.powershell);
  // Only the two fixed OS images use the existing trusted-system link policy.
  // A independently retains/rechecks its original snapshot; this child mints none.
  const system = inspectWindowsSourceSystemCustody();
  for (const [name, maximum] of [
    ["git", 128 * 1024 ** 2],
    ["powershell", 32 * 1024 ** 2],
  ] as const) {
    const image = request.tools[name],
      info = lstatSync(image.path, { bigint: true });
    assert.ok(
      info.isFile() && !info.isSymbolicLink() && info.size > 0n && info.size <= BigInt(maximum),
    );
    assert.equal(digest(readFileSync(image.path)), image.sha256);
    recheckWindowsSourceSystemCustody(system);
  }
  const binding: unknown = JSON.parse(
    read(request.binding.path, 16384, request.binding.sha256).toString("utf8"),
  );
  assert.ok(
    isRecord(binding) &&
      typeof binding.controller_root === "string" &&
      typeof binding.work_root === "string",
  );
  const hosted = inspectHostedWindowsHarnessBinding(
    binding.hosted,
    binding.controller_root,
    binding.work_root,
  );
  assert.equal(path.resolve(hosted.harness_root).toLowerCase(), path.resolve(root).toLowerCase());
  assert.equal(binding.work_root, request.work_root);
  assert.equal(binding.capture_root, request.capture_root);
  assert.ok(typeof binding.helper_sha256 === "string");
  read(
    path.join(root, "scripts/native-qualification-account.cs.txt"),
    131072,
    binding.helper_sha256,
  );
  read(
    path.join(binding.controller_root, "scripts/native-qualification-account.cs.txt"),
    131072,
    binding.helper_sha256,
  );
  read(hosted.registry.path, 131072, hosted.registry.sha256);
  assert.equal(
    read(request.package.path, request.package.bytes, request.package.sha256).length,
    request.package.bytes,
  );
  if (request.predecessor)
    assert.equal(
      read(request.predecessor.path, request.predecessor.bytes, request.predecessor.sha256).length,
      request.predecessor.bytes,
    );
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "PATH",
    "PATHEXT",
    "USERPROFILE",
    "HOME",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[name];
    assert.ok(typeof value === "string" && value.length > 0, `closed B environment lacks ${name}`);
    environment[name] = value;
  }
  assert.ok(
    Object.keys(process.env).every((name) =>
      Object.keys(environment).some((allowed) => allowed.toLowerCase() === name.toLowerCase()),
    ),
    "B worker must not inherit controller credentials or environment",
  );
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    path.join(root, "scripts/test-windows-installer.ps1"),
    "-InstallerPath",
    request.package.path,
    "-TestBase",
    path.join(request.work_root, "installer"),
    "-EvidencePath",
    path.join(request.capture_root, "installer.json"),
    "-ExpectedVersion",
    request.package.version,
    "-NativeAccountBindingPath",
    request.binding.path,
    "-NativeAccountBindingSha256",
    request.binding.sha256,
    "-NativeParentOwnsFinish",
    "-ProcessTimeoutSeconds",
    String(Math.max(1, Math.min(120, Math.floor(request.remaining_milliseconds / 1000)))),
    "-CleanupTimeoutSeconds",
    "15",
  ];
  if (request.predecessor)
    args.push(
      "-UpgradeFromInstallerPath",
      request.predecessor.path,
      "-QualifyPackageRollback",
      "-ExpectedPredecessorVersion",
      request.predecessor.version,
    );
  const identity = readProcessIdentity(process.pid);
  const match =
    typeof identity === "string" && /^win32:([1-9][0-9]*):([1-9][0-9]*)$/u.exec(identity);
  assert.ok(match && Number(match[1]) === process.pid && process.ppid === binding.broker_pid);
  const created = (BigInt(match[2]!) - 504911232000000000n).toString();
  const ready = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      created_filetime: created,
      owner_pid: binding.broker_pid,
      owner_created_filetime: binding.broker_created_filetime,
      invocation_id: binding.invocation_id,
      request_sha256: expected,
      binding_sha256: request.binding.sha256,
      stage: request.stage,
    }),
  );
  const publish = (name: string, bytes: Buffer) => {
    const fd = openSync(
      path.join(request.capture_root, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_SYNC,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  };
  publish("worker-ready.json", ready);
  publish("worker-ready.complete", Buffer.from(digest(ready)));
  const until = started + request.remaining_milliseconds;
  while (true) {
    assert.ok(performance.now() < until, "Original worker acknowledgment deadline exhausted");
    try {
      const ackFile = path.join(request.capture_root, "worker-start.json"),
        before = lstatSync(ackFile, { bigint: true });
      assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
      const acknowledgement: unknown = JSON.parse(
        (await readControllerToolFile(ackFile, 16384)).toString("utf8"),
      );
      inspectHostedWindowsWorkerAcknowledgment(acknowledgement, {
        pid: process.pid,
        created_filetime: created,
        request_sha256: expected,
        binding_sha256: request.binding.sha256,
      });
      const after = lstatSync(ackFile, { bigint: true });
      assert.ok(
        after.dev === before.dev &&
          after.ino === before.ino &&
          after.nlink === 1n &&
          after.mtimeNs === before.mtimeNs &&
          after.ctimeNs === before.ctimeNs,
      );
      assert.equal(readProcessIdentity(process.pid), identity);
      break;
    } catch (error) {
      if (!isRecord(error) || !["ENOENT", "EBUSY", "EACCES"].includes(String(error.code)))
        throw error;
    }
    await delay(25);
  }
  const remaining = Math.floor(started + request.remaining_milliseconds - performance.now());
  assert.ok(remaining > 0, "B preflight consumed remaining parent budget");
  const result = spawnSync(request.tools.powershell.path, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
    timeout: remaining,
  });
  assert.equal(result.error, undefined, "B installer child failed; retain original owner state");
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, "B installer child did not succeed; no native receipt");
  recheckWindowsSourceSystemCustody(system);
  const complete = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      created_filetime: created,
      invocation_id: binding.invocation_id,
      request_sha256: expected,
      status: 0,
      authority: "none",
    }),
  );
  publish("worker-result.json", complete);
  publish("worker-result.complete", Buffer.from(digest(complete)));
  return {
    abi: hostedWindowsWorkerAbi,
    stage: request.stage,
    status: result.status,
    scope: "selected B installer/harness child data; independent A capture required",
    authority: "none",
  };
}
