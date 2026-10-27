/** Original session/stage -> retained Windows capture. Wire data never appoints an owner. */
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  startActualHostedWindowsStage,
  settleActualHostedWindowsStage,
  requireActualHostedWindowsStage,
} from "./release-hosted-native-windows-session.mts";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import { requireHostedNativeRuntime } from "./release-hosted-native-runtime.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { readNativeCapturedStream } from "./release-native-capture-files.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  windowsSourceSystemExecutables,
  recheckWindowsSourceSystemCustody,
} from "./release-native-runtime-custody.mts";
import { isRecord } from "./runtime-values.mts";

const attempted = new WeakSet<object>();
const captures = new WeakMap<
  object,
  {
    stage: object;
    files: { name: string; bytes: number; sha256: string }[];
    custody: ReturnType<typeof inspectNativeRuntimeCustody>;
    stopped: boolean;
  }
>();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function record(raw: unknown) {
  assert.ok(isRecord(raw));
  return raw;
}
async function observeRuntime(
  actual: Awaited<ReturnType<typeof requireActualHostedWindowsStage>>,
  stage: object,
) {
  const parent = await requireActualHostedNativeParentSource(actual.parent);
  const runtime = await requireHostedNativeRuntime(actual.runtime, actual.parent);
  const context = Buffer.from(
    JSON.stringify({
      module: path.join(
        actual.tool_paths.root,
        "scripts/native-qualification-runtime-observation.psm1",
      ),
      capture: actual.directory,
      binding: actual.bindingSha,
    }),
  ).toString("base64");
  const script = `$ErrorActionPreference='Stop';$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${context}'))|ConvertFrom-Json;Import-Module $v.module -Force;Read-PortcoveNativeRuntimeObservation -CaptureRoot $v.capture -BindingSha256 $v.binding|ConvertTo-Json -Depth 8 -Compress`;
  recheckWindowsSourceSystemCustody(actual.system_custody);
  const value: unknown = JSON.parse(
    execFileSync(
      windowsSourceSystemExecutables.powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        cwd: runtime.root,
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.SystemRoot,
          PATH: path.join(String(process.env.SystemRoot), "System32"),
          PATHEXT: ".EXE",
          USERPROFILE: actual.directory,
          HOME: actual.directory,
          TEMP: actual.directory,
          TMP: actual.directory,
        },
        encoding: "utf8",
        timeout: Math.max(1, Math.min(30000, Math.floor(parent.deadline - performance.now()))),
        maxBuffer: 65536,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  await requireHostedNativeRuntime(actual.runtime, actual.parent);
  await requireActualHostedWindowsStage(stage);
  recheckWindowsSourceSystemCustody(actual.system_custody);
  return record(value);
}
export async function captureActualHostedNativeWindowsInvocation(stage: object) {
  assert.ok(!attempted.has(stage), "One original Windows capture; retain failures without retry");
  attempted.add(stage);
  const started = new Date().toISOString();
  const before = await requireActualHostedWindowsStage(stage);
  assert.ok(!before.started && !before.settled);
  await startActualHostedWindowsStage(stage);
  await settleActualHostedWindowsStage(stage);
  const actual = await requireActualHostedWindowsStage(stage);
  assert.ok(actual.started && actual.settled);
  const host = await observeRuntime(actual, stage),
    completed = new Date().toISOString();
  const files: { name: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  const take = async (name: string, stream = false) => {
    const bytes = stream
      ? await readNativeCapturedStream(actual.directory, name)
      : await readBoundedPublicBuildInputFile(actual.directory, name, 131072);
    total += bytes.length;
    assert.ok(
      total <= 256 * 1024 ** 2 && files.length < 256,
      "Bounded original Windows capture inventory required",
    );
    files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
    return bytes;
  };
  const bridge = record(JSON.parse((await take("bridge-state.json")).toString("utf8")));
  assert.ok(bridge.phase === "settled" && Array.isArray(bridge.roots) && bridge.roots.length <= 64);
  for (const item of bridge.roots) {
    const root = record(item);
    assert.ok(typeof root.id === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(root.id));
    await take(`${root.id}.stdout.bin`, true);
    await take(`${root.id}.stderr.bin`, true);
  }
  for (const name of ["harness.stdout.bin", "harness.stderr.bin"]) await take(name, true);
  for (const name of [
    "account-binding.json",
    "worker-input.json",
    "worker-ready.json",
    "worker-result.json",
    "installer.json",
    "isolated-account-desktop/native-runtime-capabilities.json",
    "isolated-account-desktop/native-runtime-processes.json",
    "isolated-account-desktop/evidence.json",
  ])
    await take(name);
  const driver = {
    schema_version: 1,
    invocation_id: actual.prepared.request.invocation_id,
    request_sha256: actual.prepared.request_sha256,
    started_at: started,
    completed_at: completed,
    failure: null,
    finish_attempted: true,
    host_observation: host,
    scope: "original hosted owner and independently settled B worker; data only",
    authority: "none",
    native_acceptance: "not-established",
  };
  const bytes = Buffer.from(JSON.stringify(driver));
  await writeFile(path.join(actual.directory, "driver-result.json"), bytes, {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  files.push({ name: "driver-result.json", bytes: bytes.length, sha256: hash(bytes) });
  const hostBytes = Buffer.from(JSON.stringify(actual.host));
  assert.ok(hostBytes.length <= 16384);
  await writeFile(path.join(actual.directory, "host-before.stdout.bin"), hostBytes, {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  files.push({ name: "host-before.stdout.bin", bytes: hostBytes.length, sha256: hash(hostBytes) });

  await requireActualHostedWindowsStage(stage);
  const receipt = Object.freeze({ kind: "original-hosted-windows-capture", authority: "none" });
  captures.set(receipt, {
    stage,
    files,
    custody: inspectNativeRuntimeCustody(files.map((row) => path.join(actual.directory, row.name))),
    stopped: false,
  });
  return receipt;
}
export async function requireActualHostedNativeWindowsCapture(receipt: object) {
  const retained = captures.get(receipt);
  assert.ok(retained && !retained.stopped, "Original active hosted Windows capture required");
  try {
    const actual = await requireActualHostedWindowsStage(retained.stage);
    assert.ok(actual.started && actual.settled);
    recheckNativeRuntimeCustody(
      retained.files.map((row) => path.join(actual.directory, row.name)),
      retained.custody,
    );
    for (const row of retained.files) {
      const bytes = /\.(?:stdout|stderr)\.bin$/u.test(row.name)
        ? await readNativeCapturedStream(actual.directory, row.name)
        : await readBoundedPublicBuildInputFile(actual.directory, row.name, Math.max(row.bytes, 1));
      assert.equal(bytes.length, row.bytes);
      assert.equal(hash(bytes), row.sha256);
    }
    const result = record(
      JSON.parse(
        (
          await readBoundedPublicBuildInputFile(actual.directory, "driver-result.json", 131072)
        ).toString("utf8"),
      ),
    );
    assert.equal(result.failure, null);
    await requireActualHostedWindowsStage(retained.stage);
    return {
      actual,
      prepared: actual.prepared,
      directory: actual.directory,
      result,
      status: 0,
      original_file_identities: Object.freeze(
        retained.files.map((row) => Object.freeze({ ...row })),
      ),
      authority: "none" as const,
    };
  } catch (error) {
    retained.stopped = true;
    throw error;
  }
}
