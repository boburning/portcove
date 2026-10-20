/** Actual fixed-parent Windows launch path. Capture provenance is private and
 * remains distinct from successful stage/report/Check acceptance. */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { requireActualNativeInvocation } from "./release-native-attempt.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const captures = new WeakMap<
  object,
  { claim: object; directory: string; result: string; status: number }
>();

export function inspectWindowsNativeDriverResult(
  raw: unknown,
  invocation: string,
  requestSha256: string,
) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "authority,children,completed_at,failure,finish_attempted,invocation_id,native_acceptance,request_sha256,schema_version,started_at" ||
    raw.schema_version !== 1 ||
    raw.authority !== "none" ||
    raw.native_acceptance !== "not-established" ||
    raw.invocation_id !== invocation ||
    raw.request_sha256 !== requestSha256 ||
    typeof raw.finish_attempted !== "boolean" ||
    !Array.isArray(raw.children) ||
    raw.children.length > 2 ||
    !(
      raw.failure === null ||
      (typeof raw.failure === "string" && raw.failure.length > 0 && raw.failure.length <= 16384)
    )
  )
    throw new Error("actual native driver result is missing or contradictory");
  const instant = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    )
      throw new Error("native driver chronology is invalid");
    return value;
  };
  const start = instant(raw.started_at),
    end = instant(raw.completed_at);
  if (end < start || Date.parse(end) - Date.parse(start) > 1900000)
    throw new Error("native driver exceeded its fixed duration");
  const seen = new Set<string>();
  const children = raw.children.map((child: unknown) => {
    if (
      !isRecord(child) ||
      Object.keys(child).sort().join(",") !== "created_filetime,exit_code,exited,pid,role" ||
      (child.role !== "bridge" && child.role !== "harness") ||
      seen.has(child.role) ||
      typeof child.pid !== "number" ||
      !Number.isSafeInteger(child.pid) ||
      child.pid < 1 ||
      typeof child.created_filetime !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(child.created_filetime) ||
      typeof child.exited !== "boolean" ||
      !(
        child.exit_code === null ||
        (typeof child.exit_code === "number" && Number.isSafeInteger(child.exit_code))
      ) ||
      (child.exited && child.exit_code === null) ||
      (!child.exited && child.exit_code !== null)
    )
      throw new Error("native driver child identity or settlement differs");
    seen.add(child.role);
    return { ...child };
  });
  if (
    raw.failure === null &&
    (children.length !== 2 ||
      raw.finish_attempted !== true ||
      children.some((child) => !child.exited || child.exit_code !== 0))
  )
    throw new Error("native driver lacks complete positive child settlement");
  return Object.freeze({
    failure: raw.failure,
    children,
    started_at: start,
    completed_at: end,
    authority: "none" as const,
    scope: "driver process capture only; no native acceptance" as const,
  });
}

export async function captureActualWindowsNativeInvocation(claim: object) {
  const selected = await requireActualNativeInvocation(claim);
  const parent = selected.parent;
  if (
    process.platform !== "win32" ||
    parent.descriptor.platform_label !== "windows-x86_64" ||
    selected.request.request.stage !== "payload-signing"
  )
    throw new Error("fixed Windows pre-sign capture required");
  const tools = parent.transport_configuration.windows_tools;
  if (!tools) throw new Error("initial Windows native runtime/driver tool pins are unavailable");
  if (
    selected.request.request.expected.producer.harness.path !== "scripts/release-native-worker.mts"
  )
    throw new Error("actual native producer must appoint the maintained fixed worker entrypoint");
  const directory = selected.capture_directory;
  const account = parent.authority_configuration.native["windows-x86_64"].host.account;
  if (!isRecord(account) || typeof account.qualification !== "string")
    throw new Error("appointed native account identity absent");
  const plan = {
    schema_version: 1,
    stage: "payload-signing",
    invocation_id: selected.request.request.invocation_id,
    request_sha256: selected.request.request_sha256,
    boundary: parent.descriptor.native_boundary_configuration,
    package: {
      path: selected.package_path,
      bytes: selected.request.request.candidate.package.bytes,
      sha256: selected.request.request.candidate.package.sha256,
    },
    version: selected.version,
    tools,
  };
  const bytes = Buffer.from(JSON.stringify(plan));
  if (bytes.byteLength > 32768) throw new Error("fixed Windows driver plan exceeds its bound");
  const planPath = path.join(directory, "windows-plan.json");
  await writeFile(planPath, bytes, { flag: "wx", mode: 0o600 });
  const signal = new EventEmitter();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.SystemRoot,
    PATH: path.join(String(process.env.SystemRoot), "System32"),
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    TEMP: directory,
    TMP: directory,
  };
  let status: number;
  try {
    status = await runResourceCommand(
      "analysis",
      tools.powershell.path,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(parent.controller_root, "scripts/release-native-windows-driver.ps1"),
        "-Plan",
        planPath,
        "-ExpectedPlanSha256",
        sha(bytes),
      ],
      {
        cwd: parent.controller_root,
        environment,
        exclusive: [`native-account:${account.qualification}`],
        supervise: async (args, options) =>
          runRustTests(args, {
            ...options,
            tempRoot: directory,
            signalTarget: signal,
            acquireLock: async (metadata, admission) => {
              if (!options.acquireLock)
                throw new Error("actual native source-bound resource admission required");
              const lease = await options.acquireLock(metadata, admission);
              try {
                await requireActualNativeInvocation(claim);
                timer = setTimeout(() => signal.emit("SIGTERM"), 1800000);
                return lease;
              } catch (error) {
                await lease.release();
                throw error;
              }
            },
          }),
      },
    );
  } finally {
    clearTimeout(timer);
  }
  const resultBytes = await readBoundedPublicBuildInputFile(directory, "driver-result.json", 32768);
  const result: unknown = JSON.parse(resultBytes.toString("utf8"));
  inspectWindowsNativeDriverResult(result, plan.invocation_id, plan.request_sha256);
  // Source credentials remain unavailable in the child. Rechecking source and
  // reservation occurs only after the supervisor has settled its owned tree.
  await requireActualNativeInvocation(claim);
  const receipt = Object.freeze({
    kind: "actual-fixed-windows-native-capture",
    directory,
    status,
    authority: "none",
    scope:
      "actual driver capture; native scenarios and Check issuance still require separate validation",
  });
  captures.set(receipt, { claim, directory, result: digest(result), status });
  return receipt;
}

export async function requireActualWindowsNativeCapture(receipt: object) {
  const retained = captures.get(receipt);
  if (!retained) throw new Error("actual fixed parent Windows capture required");
  const selected = await requireActualNativeInvocation(retained.claim);
  const raw: unknown = JSON.parse(
    (
      await readBoundedPublicBuildInputFile(retained.directory, "driver-result.json", 32768)
    ).toString("utf8"),
  );
  if (digest(raw) !== retained.result) throw new Error("actual native driver capture changed");
  const result = inspectWindowsNativeDriverResult(
    raw,
    selected.request.request.invocation_id,
    selected.request.request_sha256,
  );
  return { ...selected, result, status: retained.status, authority: "none" as const };
}
