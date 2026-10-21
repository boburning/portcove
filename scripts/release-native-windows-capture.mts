/** Actual fixed-parent Windows launch path. Capture provenance is private and
 * remains distinct from successful stage/report/Check acceptance. */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFile, lstat, readdir, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import {
  requireActualNativeInvocation,
  requireActualPublicJourneyInvocation,
} from "./release-native-attempt.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { remainingNativeParentBudget } from "./release-native-parent.mts";
import { requireActualPublicWindowsCompilerIdentity } from "./release-native-public-compiler.mts";
import {
  runActualPublicSignatureControl,
  requireActualPublicSignatureControl,
} from "./release-native-public-signature.mts";
import {
  hashNativeCapturedFile,
  readNativeCapturedStream,
} from "./release-native-capture-files.mts";
import {
  inspectPublicJourneyAttemptMarker,
  inspectPublicJourneySettlement,
} from "./release-native-public-attempt-contract.mts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const componentFiles = [
  "control.json",
  "payload.json",
  "verifier.stdout.json",
  "verifier.stderr.bin",
] as const;
const captures = new WeakMap<
  object,
  { claim: object; directory: string; result: string; status: number }
>();
const publicCaptures = new WeakMap<
  object,
  {
    claim: object;
    directory: string;
    result: string;
    status: number;
    component: object;
    filesSha256?: string;
  }
>();

/** Separate public path; no report2, Check, imported plan or candidate-stage
 * capability can be minted from this capture. */
export async function captureActualWindowsPublicJourney(claim: object) {
  const selected = await requireActualPublicJourneyInvocation(claim);
  if (
    process.platform !== "win32" ||
    selected.parent.descriptor.platform_label !== "windows-x86_64" ||
    (selected.phase !== "initial-v0-v1" && selected.phase !== "park-v0-with-v1")
  )
    throw new Error("actual Windows initial or parked public journey claim required");
  const compiler = selected.compiler_receipts;
  if (!compiler) throw new Error("actual public Windows compiler proof missing");
  const prior = await requireActualPublicWindowsCompilerIdentity(compiler.prior),
    candidate = await requireActualPublicWindowsCompilerIdentity(compiler.candidate);
  const tools = selected.parent.transport_configuration.windows_tools;
  if (!tools) throw new Error("actual fixed Windows tools missing");
  const input = {
    schema_version: selected.phase === "initial-v0-v1" ? 1 : 2,
    ...(selected.phase === "park-v0-with-v1" ? { phase: "park-v0-with-v1" } : {}),
    kind: "ordinary-public-windows-update-inputs",
    prior_installer_sha256: selected.prior_package.identity.package.sha256,
    prior_executable_sha256: prior.identity.executable.nsis_sha256,
    prior_version: selected.prior_package.identity.version,
    candidate_installer_sha256: selected.candidate_package.identity.package.sha256,
    candidate_executable_sha256: candidate.identity.executable.nsis_sha256,
    candidate_version: selected.candidate_package.identity.version,
  };
  const inputBytes = Buffer.from(JSON.stringify(input)),
    inputPath = path.join(selected.capture_directory, "public-inputs.json");
  await writeFile(inputPath, inputBytes, { flag: "wx", mode: 0o600 });
  const component = await runActualPublicSignatureControl(
    selected.pair_receipt,
    selected.prior_package_receipt,
    selected.candidate_package_receipt,
    selected.pair.directory,
    selected.original_deadline,
  );
  const componentProof = await requireActualPublicSignatureControl(component);
  const componentDirectory = path.join(selected.capture_directory, "signature-control");
  await mkdir(componentDirectory, { mode: 0o700 });
  for (const file of componentFiles) {
    const bytes = await readNativeCapturedStream(componentProof.directory, file);
    assert.ok(bytes.length <= 64 * 1024);
    await writeFile(path.join(componentDirectory, file), bytes, { flag: "wx", mode: 0o600 });
    remainingNativeParentBudget();
  }
  await requireActualPublicSignatureControl(component);
  const plan = {
    schema_version: 2,
    stage: selected.phase === "initial-v0-v1" ? "ordinary-public-initial" : "ordinary-public-park",
    journey: null,
    predecessor: null,
    invocation_id: selected.invocation_id,
    request_sha256: selected.request_sha256,
    boundary: selected.parent.descriptor.native_boundary_configuration,
    package: {
      path: selected.prior_package.path,
      bytes: selected.prior_package.identity.package.bytes,
      sha256: input.prior_installer_sha256,
    },
    version: input.prior_version,
    tools,
    public_inputs: { path: inputPath, sha256: sha(inputBytes) },
  };
  const captured = await runFixedWindowsCapture(
    selected.parent,
    selected.capture_directory,
    plan,
    async () => {
      await requireActualPublicJourneyInvocation(claim);
      await requireActualPublicSignatureControl(component);
    },
  );
  const receipt = Object.freeze({
    kind: "actual-fixed-windows-public-capture",
    authority: "none" as const,
  });
  publicCaptures.set(receipt, {
    claim,
    directory: selected.capture_directory,
    ...captured,
    component,
  });
  await requireActualWindowsPublicCapture(receipt);
  return receipt;
}

export async function requireActualWindowsPublicCapture(receipt: object) {
  const retained = publicCaptures.get(receipt);
  if (!retained) throw new Error("actual fixed parent Windows public capture required");
  const selected = await requireActualPublicJourneyInvocation(retained.claim);
  const raw: unknown = JSON.parse(
    (
      await readBoundedPublicBuildInputFile(retained.directory, "driver-result.json", 32768)
    ).toString("utf8"),
  );
  if (digest(raw) !== retained.result) throw new Error("actual public driver capture changed");
  const driver = inspectWindowsNativeDriverResult(
    raw,
    selected.invocation_id,
    selected.request_sha256,
  );
  const component = await requireActualPublicSignatureControl(retained.component);
  for (const file of componentFiles) {
    const original = await readNativeCapturedStream(component.directory, file);
    const captured = await readNativeCapturedStream(
      retained.directory,
      `signature-control/${file}`,
    );
    assert.ok(
      original.length <= 64 * 1024 && original.equals(captured),
      "retained signature component evidence differs",
    );
    remainingNativeParentBudget();
  }
  assert.equal(retained.status, 0);
  assert.equal(driver.failure, null);
  const readJson = async (file: string) =>
    JSON.parse(
      (await readBoundedPublicBuildInputFile(retained.directory, file, 4 * 1024 * 1024)).toString(
        "utf8",
      ),
    ) as unknown;
  const bridge = await readJson("bridge-state.json"),
    binding = await readJson("account-binding.json"),
    report = await readJson("ordinary-public-update/public-update-journey.json");
  assert.ok(isRecord(bridge) && isRecord(binding) && isRecord(report));
  assert.equal(bridge.phase, "settled");
  assert.equal(bridge.failure, null);
  assert.deepEqual(bridge.group_remaining_pids, []);
  assert.equal(bridge.invocation_id, selected.invocation_id);
  assert.equal(binding.invocation_id, selected.invocation_id);
  assert.equal(bridge.configuration_sha256, binding.configuration_sha256);
  const account = selected.parent.authority_configuration.native["windows-x86_64"].host.account;
  assert.ok(isRecord(account));
  assert.equal(binding.account_sid, account.qualification);
  const broker = driver.children.find((child) => child.role === "bridge");
  assert.ok(broker);
  assert.equal(bridge.broker_pid, broker.pid);
  assert.equal(bridge.broker_created_filetime, broker.created_filetime);
  assert.equal(binding.broker_pid, broker.pid);
  assert.equal(binding.broker_created_filetime, broker.created_filetime);
  assert.equal(report.schema_version, 1);
  assert.equal(report.authority, "none");
  assert.equal(report.native_acceptance, "not-established");
  const parked = selected.phase === "park-v0-with-v1";
  assert.equal(report.phase, selected.phase);
  assert.equal(report.outcome, parked ? "parked" : "observed");
  assert.ok(
    isRecord(report.user_state) &&
      isRecord(report.user_state.before) &&
      isRecord(report.user_state.after),
  );
  assert.equal(
    report.user_state.before.application_version,
    selected.prior_package.identity.version,
  );
  assert.equal(
    report.user_state.after.application_version,
    parked ? selected.prior_package.identity.version : selected.candidate_package.identity.version,
  );
  const compiler = selected.compiler_receipts;
  assert.ok(compiler);
  const candidate = await requireActualPublicWindowsCompilerIdentity(compiler.candidate);
  if (parked) {
    assert.ok(isRecord(report.parked) && isRecord(report.parked.status));
    const prior = await requireActualPublicWindowsCompilerIdentity(compiler.prior);
    assert.equal(report.parked.installed_sha256, prior.identity.executable.nsis_sha256);
    assert.equal(
      report.parked.staged_installer_sha256,
      selected.candidate_package.identity.package.sha256,
    );
    assert.equal(report.parked.status.apply, null);
    assert.ok(isRecord(report.parked.status.staged));
    assert.equal(report.parked.status.staged.version, selected.candidate_package.identity.version);
    assert.deepEqual(report.parked.status.recovery_required, []);
    const installer = await readJson("installer.json");
    assert.ok(isRecord(installer) && isRecord(installer.details));
    assert.equal(installer.phase, "public_v1_parked");
    assert.equal(installer.details.kept_installed, true);
    assert.equal(installer.details.registered_version, selected.prior_package.identity.version);
    assert.equal(
      installer.details.installed_executable_sha256,
      prior.identity.executable.nsis_sha256,
    );
  } else {
    assert.ok(
      isRecord(report.automatic_relaunch) && isRecord(report.automatic_relaunch.executable),
    );
    assert.equal(
      report.automatic_relaunch.executable.sha256,
      candidate.identity.executable.nsis_sha256,
    );
    assert.ok(Array.isArray(report.recovery_cases));
    assert.deepEqual(
      report.recovery_cases
        .map((item) => {
          assert.ok(isRecord(item));
          assert.ok(typeof item.area === "string");
          return item.area;
        })
        .sort((a, b) => a.localeCompare(b)),
      ["apply", "schedule", "staging"],
    );
  }
  assert.ok(isRecord(report.harness));
  assert.equal(
    report.harness.sha256,
    sha(
      await readBoundedPublicBuildInputFile(
        selected.parent.controller_root,
        "apps/desktop/scripts/desktop-windows-public-update.mts",
        1024 * 1024,
      ),
    ),
  );
  assert.ok(Array.isArray(bridge.roots) && bridge.roots.length > 0 && bridge.roots.length <= 64);
  const roots = bridge.roots.map((rawRoot) => {
    assert.ok(isRecord(rawRoot) && isRecord(rawRoot.teardown));
    const teardown = rawRoot.teardown;
    assert.equal(teardown.root_pid, rawRoot.pid);
    assert.equal(teardown.root_created_filetime, rawRoot.created_filetime);
    return {
      root_pid: rawRoot.pid,
      creation: { kind: "windows-filetime", value: rawRoot.created_filetime },
      root_exited: teardown.root_exited,
      job_empty: teardown.job_empty,
      remaining_pids: teardown.remaining_pids,
      exit_code: teardown.exit_code,
    };
  });
  const files: Awaited<ReturnType<typeof hashNativeCapturedFile>>[] = [];
  let directories = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    assert.ok(depth <= 12 && ++directories <= 128, "public capture directory bound exhausted");
    for (const entry of (await readdir(path.join(retained.directory, relative))).sort()) {
      if (!relative && entry === "public-settlement.json") continue;
      assert.match(entry, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
      const name = relative ? `${relative}/${entry}` : entry;
      const info = await lstat(path.join(retained.directory, name));
      assert.ok(!info.isSymbolicLink());
      if (info.isDirectory()) {
        await walk(name, depth + 1);
        continue;
      }
      assert.ok(files.length < 512, "public retained file inventory exceeds bound");
      const payload =
        /^ordinary-public-update\/(?:before-startup-[0-5]|before-local-payload-tamper|before-(?:schedule|staging|apply)-fault|parked-v1)\/staging-(?:candidate-installer[.]exe|[.]candidate[.]payload[.]incoming)$/u.test(
          name,
        );
      files.push(
        await hashNativeCapturedFile(
          retained.directory,
          name,
          (payload ? 512 : 4) * 1024 * 1024,
          selected.original_deadline,
        ),
      );
    }
  };
  await walk("", 0);
  const marker = inspectPublicJourneyAttemptMarker(await readJson("claim.json"), {
    invocation_id: selected.invocation_id,
    descriptor_sha256: selected.parent.descriptor_sha256,
    setup_grant_sha256: selected.parent.descriptor.setup_grant_sha256,
  });
  const settlement = {
    schema_version: 1,
    kind: "ordinary-public-native-settlement",
    authority: "none",
    invocation_id: selected.invocation_id,
    request_sha256: selected.request_sha256,
    phase: selected.phase,
    platform_label: "windows-x86_64",
    proof_outcome: "completed",
    group: { empty: true, remaining_pids: [], observed_at: bridge.observed_at },
    roots,
    files,
    wire: null,
  };
  inspectPublicJourneySettlement(settlement, marker);
  const filesSha256 = digest(files);
  if (retained.filesSha256)
    assert.equal(filesSha256, retained.filesSha256, "public retained file inventory changed");
  else retained.filesSha256 = filesSha256;
  remainingNativeParentBudget();
  return {
    ...selected,
    claim: retained.claim,
    driver,
    component,
    status: retained.status,
    settlement,
    authority: "none" as const,
  };
}

export function inspectWindowsNativeDriverResult(
  raw: unknown,
  invocation: string,
  requestSha256: string,
) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "authority,children,completed_at,failure,finish_attempted,host_observation,invocation_id,native_acceptance,request_sha256,schema_version,started_at" ||
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
    host_observation: structuredClone(raw.host_observation),
  });
}

export async function captureActualWindowsNativeInvocation(claim: object) {
  const selected = await requireActualNativeInvocation(claim);
  const parent = selected.parent;
  if (
    process.platform !== "win32" ||
    parent.descriptor.platform_label !== "windows-x86_64" ||
    (selected.request.request.stage !== "payload-signing" &&
      selected.request.request.stage !== "release-publication")
  )
    throw new Error("fixed Windows native stage capture required");
  const request = selected.request.request;
  if (request.stage === "release-publication") {
    if (
      request.native_report_schema_version !== 2 ||
      !request.journey ||
      !selected.payload_cryptography ||
      selected.payload_cryptography.signed_context_sha256 !==
        request.journey.signed_context_sha256 ||
      selected.payload_cryptography.signatures_sha256 !== request.journey.signatures_sha256 ||
      ("predecessor" in request.journey ? !selected.predecessor : selected.predecessor !== null)
    )
      throw new Error("fixed post-sign package capture lacks original crypto/predecessor custody");
  }
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
    stage: selected.request.request.stage,
    journey: selected.request.request.journey,
    predecessor: selected.predecessor,
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
  const captured = await runFixedWindowsCapture(parent, directory, plan, async () => {
    await requireActualNativeInvocation(claim);
  });
  const receipt = Object.freeze({
    kind: "actual-fixed-windows-native-capture",
    directory,
    status: captured.status,
    authority: "none",
    scope:
      "actual driver capture; native scenarios and Check issuance still require separate validation",
  });
  captures.set(receipt, { claim, directory, ...captured });
  return receipt;
}

/** Module-private launcher: both public and stage callers must first establish
 * their own actual private claim. No exported raw plan/launch callback exists. */
async function runFixedWindowsCapture(
  parent: Awaited<ReturnType<typeof requireActualNativeInvocation>>["parent"],
  directory: string,
  plan: {
    invocation_id: string;
    request_sha256: string;
    tools: NonNullable<
      Awaited<
        ReturnType<typeof requireActualNativeInvocation>
      >["parent"]["transport_configuration"]["windows_tools"]
    >;
  } & Record<string, unknown>,
  recheck: () => Promise<void>,
) {
  const tools = plan.tools;
  const account = parent.authority_configuration.native["windows-x86_64"].host.account;
  if (!isRecord(account) || typeof account.qualification !== "string")
    throw new Error("appointed native account identity absent");
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
        queueDeadline: Math.floor(performance.now() + remainingNativeParentBudget()),
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
                await recheck();
                timer = setTimeout(
                  () => signal.emit("SIGTERM"),
                  remainingNativeParentBudget(1800000),
                );
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
  await recheck();
  return { result: digest(result), status };
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
