import { selectedHostedNativePlatform } from "./release-authority-configuration-contract.mts";
/** One original controller realm owns the persistent Windows credential process. */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, open } from "node:fs/promises";
import { constants, openSync, closeSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { requireActualHostedWindowsInstallation } from "./release-hosted-native-windows-installation.mts";
import { requireActualHostedWindowsDependencies } from "./release-hosted-native-windows-source.mts";
import {
  requireActualHostedNativeParentSource,
  createActualHostedNativeParentSource,
} from "./release-hosted-native-parent.mts";
import {
  requireHostedNativeRuntime,
  hostedNativeSupportDependencies,
  joinHostedWindowsPostSignRuntime,
} from "./release-hosted-native-runtime.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  windowsSourceSystemExecutables,
  readWindowsNativeProcessFiletime,
  recheckWindowsSourceSystemCustody,
} from "./release-native-runtime-custody.mts";
import { assertControllerBootstrapEnvironment } from "./release-controller-job-bootstrap.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import {
  hostedWindowsOwnerDeadline,
  hostedWindowsWorkerAbi,
  inspectHostedWindowsWorkerRequest,
} from "./release-hosted-native-windows-worker-contract.mts";
import { isRecord } from "./runtime-values.mts";
import {
  requireActualHostedNativeCandidate,
  readActualHostedNativePostSignController,
  readActualHostedNativePostSignJourney,
  acquireActualHostedNativePostSignPackage,
} from "./release-hosted-native-candidate.mts";
import { nativeInvocationIdentity } from "./release-native-candidate.mts";
import { prepareHostedNativeStageRequest } from "./release-native-stage-capture.mts";
import { inspectHostedNativeWindowsHost } from "./release-hosted-native-windows-host.mts";
import {
  acquireActualHostedNativePostSignInputs,
  verifyActualHostedNativePostSignPayload,
  requireActualHostedNativePostSignPayload,
} from "./release-hosted-native-postsign-inputs.mts";

import {
  windowsOwnerEnvironment as ownerEnvironment,
  captureWindowsOwnerSupervisor as captureOwnerSupervisor,
  writeWindowsOwnerFrame,
  readWindowsOwnerRecord,
  readWindowsOwnerWorkerRecord,
  copyWindowsOwnerStageFile,
  establishWindowsOwnerAccount,
  startWindowsOwnerStageMechanism,
  settleWindowsOwnerStageMechanism,
} from "./release-windows-owner-mechanism.mts";

export const hostedWindowsSessionExecutionAuthorized = false;
const attempts = new WeakSet<object>();
type Installation = Awaited<ReturnType<typeof requireActualHostedWindowsInstallation>>;
type Parent = Awaited<ReturnType<typeof requireActualHostedNativeParentSource>>;
type State = {
  supervisor?: { pid: number | undefined; identity?: string };
  installation: object;
  setupSource: Buffer;
  recoverySource: Buffer;
  stage?: object;
  prepared: Installation;
  parent: Parent;
  tools: Awaited<ReturnType<typeof verifiedControllerToolPaths>>;
  root: string;
  binding: string;
  owner: { pid: number; created: string; broker: string; bridge: string };
  phase: "initializing" | "preparing" | "await-post" | "post" | "finished";
  activeTicks: string;
  fullTicks: string;
  frequency: number;
  sequence: number;
  files: string[];
  custody: ReturnType<typeof inspectNativeRuntimeCustody>;
  signal: EventEmitter;
  running: Promise<number>;
  status: number | undefined;
  error: unknown;
  stopped: boolean;
  recoveryAttempted: boolean;
  preAttempted: boolean;
  deadline: number;
  clockSample: string;
  clockReceived: number;
  postParent?: object;
  account: { sid: string; description: string; profile: string } | null;
};
const sessions = new WeakMap<object, State>();
type Stage = {
  session: object;
  kind: "payload-signing" | "release-publication";
  candidate: object;
  parent: object;
  prepared: ReturnType<typeof prepareHostedNativeStageRequest>;
  directory: string;
  binding: Record<string, unknown>;
  bindingFile: string;
  bindingSha: string;
  files: string[];
  custody: ReturnType<typeof inspectNativeRuntimeCustody>;
  host: unknown;
  hostNonce: string;
  started: boolean;
  settled: boolean;
  stopped: boolean;
  station: { before: Buffer; proposed: Buffer } | null;
  workerRequestSha: string;
  worker?: { pid: number; created: string };
};
const stages = new WeakMap<object, Stage>();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function active(state: State) {
  assertControllerBootstrapEnvironment();
  state.parent.recheck();
  assert.ok(
    !state.stopped &&
      performance.now() < state.deadline &&
      state.status === undefined &&
      state.error === undefined,
    "original hosted session stopped or expired",
  );
}
async function retain(file: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  assert.ok(bytes.length <= 16384);
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_SYNC,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return bytes;
}
async function readOwner(state: State, name: string) {
  return readWindowsOwnerRecord(
    { root: state.root, binding: state.binding, active: () => active(state) },
    name,
  );
}
function writeFramedFile(state: State, file: string, wire: Record<string, unknown>) {
  active(state);
  recheckWindowsSourceSystemCustody(state.prepared.system_custody);
  writeWindowsOwnerFrame(file, wire, {
    root: state.root,
    deadline: state.deadline,
    powershell: windowsSourceSystemExecutables.powershell,
    environment: ownerEnvironment(state.root),
  });
  recheckWindowsSourceSystemCustody(state.prepared.system_custody);
  active(state);
}
function writeRequest(state: State, name: string, value: Record<string, unknown>) {
  writeFramedFile(state, path.join(state.root, name), {
    ...value,
    binding: state.binding,
    owner_pid: state.owner.pid,
    owner_created_filetime: state.owner.created,
    sequence: state.sequence,
  });
  state.sequence++;
}
async function remember(state: State, files: string[]) {
  recheckNativeRuntimeCustody(state.files, state.custody);
  assert.ok(
    files.every((file) => !state.files.includes(file)),
    "retain each owner file once; no rebasing custody",
  );
  const nextFiles = [...state.files, ...files],
    observed = inspectNativeRuntimeCustody(nextFiles);
  for (const [file, identity] of state.custody)
    assert.equal(
      observed.get(file),
      identity,
      "retained owner custody changed during inventory; no rebasing",
    );
  state.files = nextFiles;
  state.custody = observed;
  active(state);
}
async function recheck(state: State) {
  active(state);
  recheckNativeRuntimeCustody(state.files, state.custody);
  await requireActualHostedWindowsDependencies(state.prepared.dependencies);
  const runtime = await requireHostedNativeRuntime(state.prepared.runtime, state.prepared.parent);
  state.deadline = Math.min(state.deadline, runtime.deadline);
  await requireActualHostedNativeParentSource(state.prepared.parent);
  assert.equal(
    readWindowsNativeProcessFiletime(state.owner.pid, state.deadline),
    state.owner.created,
  );
  recheckNativeRuntimeCustody(state.files, state.custody);
  active(state);
}

export async function startActualHostedWindowsSession(installationReceipt: object) {
  assert.ok(
    hostedWindowsSessionExecutionAuthorized,
    "held hosted session execution awaits separate authority",
  );
  assert.ok(process.platform === "win32" && process.arch === "x64");
  assertControllerBootstrapEnvironment();
  const prepared = await requireActualHostedWindowsInstallation(installationReceipt),
    parent = await requireActualHostedNativeParentSource(prepared.parent);
  assert.ok(
    !attempts.has(prepared.parent),
    "one original Windows credential owner; retain and recover",
  );
  attempts.add(prepared.parent);
  assert.equal(parent.configuration.purpose, "application");
  assert.ok(
    parent.configuration.schema_version === 4 && parent.configuration.hosted_native,
    "hosted Windows configuration required",
  );
  const tools = await verifiedControllerToolPaths(prepared.tools);
  assert.equal(tools.platform, "windows-x86_64");
  await requireHostedNativeRuntime(prepared.runtime, prepared.parent);
  const helper = await readControllerToolFile(
    path.join(tools.root, "scripts/native-qualification-account.cs.txt"),
    131072,
  );
  assert.ok(
    helper.equals(
      await readControllerToolFile(
        path.join(prepared.root, "scripts/native-qualification-account.cs.txt"),
        131072,
      ),
    ),
    "original A/B helper ABI differs before effects",
  );
  const registry = await readControllerToolFile(
    path.join(tools.root, "scripts/native-qualification-account-registry.ps1"),
    131072,
  );
  assert.ok(
    registry.equals(
      await readControllerToolFile(
        path.join(prepared.root, "scripts/native-qualification-account-registry.ps1"),
        131072,
      ),
    ),
    "original A/B registry reader differs before effects",
  );
  const setupSource = await readControllerToolFile(
      path.join(tools.root, "scripts/release-hosted-native-windows-setup.cs.txt"),
      131072,
    ),
    recoverySource = await readControllerToolFile(
      path.join(tools.root, "scripts/release-hosted-native-windows-recovery.ps1"),
      131072,
    );
  const root = path.join(parent.directory, "windows-session");
  await mkdir(root);
  const binding = randomBytes(32).toString("hex"),
    context = {
      schema_version: 1,
      binding,
      root,
      tools_root: tools.root,
      source_root: prepared.root,
      node_pid: process.pid,
      node_created_filetime: readWindowsNativeProcessFiletime(process.pid, parent.deadline),
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: 1,
      source_commit: selectedHostedNativePlatform(parent.configuration, "windows-x86_64").producer
        .source_commit,
      source_tree: selectedHostedNativePlatform(parent.configuration, "windows-x86_64").producer
        .source_tree,
    };
  const contextBytes = await retain(path.join(root, "owner-context.json"), context);
  const readbackSource = path.join(root, "original-station-readback.cs.txt"),
    readbackHandle = await open(
      readbackSource,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_SYNC,
      0o600,
    );
  try {
    await readbackHandle.writeFile(setupSource);
    await readbackHandle.sync();
  } finally {
    await readbackHandle.close();
  }

  // An unsupported B ABI is rejected before the owner can create an account.
  const probe = await probeSelectedWorker(prepared, tools.node, root);
  const abi: unknown = JSON.parse(probe);
  assert.ok(
    isRecord(abi) &&
      abi.abi === hostedWindowsWorkerAbi &&
      abi.worker === "scripts/release-native-worker.mts" &&
      abi.authority === "none" &&
      abi.execution_authorized === true,
  );
  const signal = new EventEmitter(),
    support = await hostedNativeSupportDependencies(prepared.runtime, prepared.parent, root);
  const state: State = {
    installation: installationReceipt,
    setupSource,
    recoverySource,
    prepared,
    parent,
    tools,
    root,
    binding,
    owner: { pid: 0, created: "", broker: "", bridge: "" },
    phase: "initializing",
    activeTicks: "",
    fullTicks: "",
    frequency: 0,
    sequence: 1,
    files: [path.join(root, "owner-context.json"), readbackSource],
    custody: inspectNativeRuntimeCustody([path.join(root, "owner-context.json"), readbackSource]),
    signal,
    running: Promise.resolve(-1),
    status: undefined,
    error: undefined,
    stopped: false,
    recoveryAttempted: false,
    preAttempted: false,
    deadline: parent.deadline,
    clockSample: "",
    clockReceived: 0,
    account: null,
  };
  const ownerOutput = ["owner.stdout.bin", "owner.stderr.bin"].map((name) =>
    openSync(path.join(root, name), "wx", 0o600),
  );
  state.running = runResourceCommand(
    "analysis",
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(tools.root, "scripts/release-hosted-native-windows-owner.ps1"),
      "-ContextBase64",
      contextBytes.toString("base64"),
    ],
    {
      cwd: tools.root,
      environment: ownerEnvironment(root),
      queueDeadline: parent.deadline,
      executionTimeoutMilliseconds: Math.max(1, Math.floor(parent.deadline - performance.now())),
      output: { stdout: ownerOutput[0]!, stderr: ownerOutput[1]! },
      exclusive: ["native-windows-original-account-owner"],
      supervise: (args, options) =>
        runRustTests(args, {
          ...options,
          ...support,
          tempRoot: root,
          signalTarget: signal,
          spawn: captureOwnerSupervisor(state, ownerOutput),
        }),
    },
  );
  void state.running
    .finally(() => {
      for (const fd of ownerOutput) closeSync(fd);
    })
    .catch(() => {});
  void state.running.then(
    (status) => {
      state.status = status;
    },
    (error) => {
      state.error = error;
    },
  );
  const timer = setTimeout(
    () => signal.emit("SIGTERM"),
    Math.max(1, Math.floor(parent.deadline - performance.now())),
  );
  void state.running.finally(() => clearTimeout(timer)).catch(() => {});
  try {
    await establishWindowsOwnerAccount(state, {
      toolsRoot: tools.root,
      powershell: windowsSourceSystemExecutables.powershell,
      read: (name) => readOwner(state, name),
      remember: (files) => remember(state, files),
      write: (name, value) => writeRequest(state, name, value),
      inspectLineage: (...args) => inspectChildLineage(state, ...args),
      inspectAccount: (enabled) => inspectOriginalHostedWindowsAccount(state, enabled),
      recheck: () => recheck(state),
    });
    state.phase = "preparing";
    const receipt = Object.freeze({ kind: "original-hosted-windows-session", authority: "none" });
    sessions.set(receipt, state);
    return receipt;
  } catch (error) {
    await failSession(state, error);
    throw error;
  }
}

async function probeSelectedWorker(prepared: Installation, node: string, directory: string) {
  const parent = await requireActualHostedNativeParentSource(prepared.parent),
    support = await hostedNativeSupportDependencies(prepared.runtime, prepared.parent, directory),
    signal = new EventEmitter();
  const descriptors = ["worker-abi.stdout.bin", "worker-abi.stderr.bin"].map((name) =>
    openSync(path.join(directory, name), "wx", 0o600),
  );
  let failure: unknown;
  const timer = setTimeout(
    () => signal.emit("SIGTERM"),
    Math.max(1, Math.floor(parent.deadline - performance.now())),
  );
  try {
    const status = await runResourceCommand(
      "analysis",
      node,
      [path.join(prepared.root, "scripts/release-native-worker.mts"), "--hosted-windows-abi"],
      {
        cwd: prepared.root,
        environment: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.SystemRoot,
          PATH: path.dirname(node) + ";" + path.join(String(process.env.SystemRoot), "System32"),
          PATHEXT: ".EXE",
          USERPROFILE: directory,
          HOME: directory,
          TEMP: directory,
          TMP: directory,
        },
        queueDeadline: parent.deadline,
        executionTimeoutMilliseconds: Math.min(
          15000,
          Math.floor(parent.deadline - performance.now()),
        ),
        output: { stdout: descriptors[0]!, stderr: descriptors[1]! },
        supervise: (args, options) =>
          runRustTests(args, {
            ...options,
            ...support,
            tempRoot: directory,
            signalTarget: signal,
            spawn: (command, args, options) => {
              const child = spawn(command, [...args], {
                ...options,
                stdio: ["pipe", "pipe", "pipe"],
              });
              for (const [stream, index] of [
                [child.stdout, 0],
                [child.stderr, 1],
              ] as const) {
                let size = 0;
                stream.on("data", (bytes: Buffer) => {
                  try {
                    const count = Math.min(bytes.length, Math.max(0, 16384 - size));
                    if (count) writeSync(descriptors[index]!, bytes.subarray(0, count));
                    size += bytes.length;
                    assert.ok(size <= 16384);
                  } catch (error) {
                    failure ??= error;
                    signal.emit("SIGTERM");
                  }
                });
                stream.on("error", (error) => {
                  failure ??= error;
                  signal.emit("SIGTERM");
                });
              }
              return child;
            },
          }),
      },
    );
    assert.equal(failure, undefined);
    assert.equal(status, 0, "Prepared B ABI probe refused");
    await requireActualHostedNativeParentSource(prepared.parent);
    return (
      await readControllerToolFile(path.join(directory, "worker-abi.stdout.bin"), 16384)
    ).toString("utf8");
  } finally {
    clearTimeout(timer);
    for (const fd of descriptors) closeSync(fd);
  }
}
async function inspectChildLineage(
  state: State,
  pid: number,
  created: string,
  parent: number,
  image: string,
) {
  active(state);
  recheckWindowsSourceSystemCustody(state.prepared.system_custody);
  assert.ok(
    Number.isSafeInteger(pid) &&
      pid > 0 &&
      pid <= 2147483647 &&
      Number.isSafeInteger(parent) &&
      parent > 0,
  );
  assert.equal(readWindowsNativeProcessFiletime(pid, state.deadline), created);
  const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -Property ProcessId,ParentProcessId,ExecutablePath -OperationTimeoutSec 5;if(-not $p){throw 'Original child unavailable'};[ordered]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;image=$p.ExecutablePath}|ConvertTo-Json -Compress`;
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
        cwd: state.root,
        env: ownerEnvironment(state.root),
        encoding: "utf8",
        timeout: Math.max(1, Math.min(10000, Math.floor(state.deadline - performance.now()))),
        maxBuffer: 16384,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert.ok(
    isRecord(value) &&
      value.pid === pid &&
      value.parent === parent &&
      typeof value.image === "string" &&
      value.image.toLowerCase() === image.toLowerCase(),
  );
  assert.equal(readWindowsNativeProcessFiletime(pid, state.deadline), created);
  recheckWindowsSourceSystemCustody(state.prepared.system_custody);
  active(state);
}
async function readWorkerRecord(
  state: State,
  stage: Stage,
  name: "worker-ready" | "worker-result",
) {
  return readWindowsOwnerWorkerRecord({ active: () => active(state) }, stage.directory, name);
}
async function inspectOriginalHostedWindowsAccount(state: State, enabled: boolean) {
  recheckWindowsSourceSystemCustody(state.prepared.system_custody);
  assert.ok(state.account);
  const expected = Buffer.from(
    JSON.stringify({ sid: state.account.sid, description: state.account.description, enabled }),
  ).toString("base64");
  const script = `$ErrorActionPreference='Stop';$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'))|ConvertFrom-Json;$u=Get-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($v.sid));if($u.Name -cne 'PortcoveNativeQual' -or $u.Description -cne $v.description -or $u.Enabled -ne $v.enabled){throw 'Original account OS state differs'};[ordered]@{sid=$u.SID.Value;enabled=$u.Enabled;broker_sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}|ConvertTo-Json -Compress`;
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
        env: ownerEnvironment(state.root),
        cwd: state.root,
        encoding: "utf8",
        timeout: Math.max(1, Math.min(15000, Math.floor(state.deadline - performance.now()))),
        maxBuffer: 16384,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert.ok(
    isRecord(value) &&
      value.sid === state.account.sid &&
      value.enabled === enabled &&
      value.broker_sid === state.owner.broker,
  );
}

async function observeHost(state: State) {
  recheckWindowsSourceSystemCustody(state.prepared.system_custody);
  active(state);
  const script = `$ErrorActionPreference='Stop';$o=Get-CimInstance Win32_OperatingSystem -Property Caption,Version,BuildNumber,ProductType -OperationTimeoutSec 5;$v=Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -Name DisplayVersion;$m=[string](Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid);if($m -cnotmatch '^[a-fA-F0-9-]{32,36}$'){throw 'Machine identity unavailable'};$h=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($m.ToLowerInvariant()))).ToLowerInvariant();[ordered]@{schema_version=1;nonce='${state.binding}';architecture='x86_64';broker_sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;machine_id_sha256=$h;os=[ordered]@{caption=$o.Caption;version=$o.Version;build_number=$o.BuildNumber;product_type=[int]$o.ProductType;display_version=$v}}|ConvertTo-Json -Depth 5 -Compress`;
  const raw: unknown = JSON.parse(
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
        cwd: state.root,
        env: ownerEnvironment(state.root),
        encoding: "utf8",
        timeout: Math.max(1, Math.min(15000, Math.floor(state.deadline - performance.now()))),
        maxBuffer: 16384,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert.equal(state.parent.configuration.purpose, "application");
  const selected = selectedHostedNativePlatform(state.parent.configuration, "windows-x86_64");
  assert.ok(
    selected.minimum_platform === "windows-11-26h2-x64" ||
      selected.minimum_platform === "windows-server-2022-x64-continuity",
  );
  const host = inspectHostedNativeWindowsHost(
    raw,
    state.binding,
    selected.minimum_platform,
    selected.compatibility.minimum_os_version,
  );
  assert.equal(host.broker_sid, state.owner.broker);
  active(state);
  return { raw, host };
}
async function copyStageFile(
  state: State,
  source: string,
  destination: string,
  maximum: number,
  expected: string,
) {
  return copyWindowsOwnerStageFile(
    { active: () => active(state) },
    source,
    destination,
    maximum,
    expected,
  );
}
async function prepareStage(
  session: object,
  kind: "payload-signing" | "release-publication",
  candidateReceipt: object,
  parentReceipt: object,
) {
  const state = sessions.get(session);
  assert.ok(
    state && state.phase === (kind === "payload-signing" ? "preparing" : "post"),
    "original Windows stage session required",
  );
  try {
    await recheck(state);
    assert.ok(state.account);
    const candidate =
      kind === "payload-signing"
        ? await requireActualHostedNativeCandidate(candidateReceipt)
        : await requireActualHostedNativePostSignPayload(candidateReceipt);
    assert.equal(candidate.parent_source, parentReceipt);
    const observed = await observeHost(state),
      projection = {
        qualification_profile: "fixed-hosted-native-v1",
        machine_id_sha256: observed.host.machine_id_sha256,
        account: {
          kind: "windows-sid",
          broker: state.owner.broker,
          qualification: state.account.sid,
        },
      };
    const input = {
      schema_version: 1,
      stage: kind,
      platform_label: "windows-x86_64",
      candidate: candidate.candidate,
      journey: "journey" in candidate ? candidate.journey : null,
      invocation_id: "0".repeat(64),
      setup_descriptor_sha256: state.parent.configuration.journal.setup_plan_sha256,
    };
    const provisional = prepareHostedNativeStageRequest(
        input,
        state.parent.configuration,
        projection,
      ),
      invocation = nativeInvocationIdentity(provisional, candidate.recovery),
      prepared = prepareHostedNativeStageRequest(
        { ...input, invocation_id: invocation.invocation_id },
        state.parent.configuration,
        projection,
      );
    writeRequest(state, kind + "-prepare.json", { active_deadline_ticks: state.activeTicks });
    const paths = await readOwner(state, kind + "-prepared.json"),
      stageRoot = path.join(state.root, kind),
      directory = path.join(stageRoot, "capture"),
      readonly = path.join(stageRoot, "readonly"),
      work = path.join(stageRoot, "work");
    assert.equal(paths.value.stage, kind);
    assert.equal(paths.value.capture_root, directory);
    assert.equal(paths.value.readonly_root, readonly);
    assert.equal(paths.value.work_root, work);
    const files = [paths.file],
      manifest: unknown = JSON.parse(
        (
          await readControllerToolFile(path.join(state.tools.root, "manifest.json"), 65536)
        ).toString("utf8"),
      );
    assert.ok(isRecord(manifest) && Array.isArray(manifest.files));
    const manifestFiles: unknown[] = manifest.files;
    const member = (name: string) => {
      const selected = manifestFiles.filter((row: unknown) => isRecord(row) && row.path === name);
      assert.equal(selected.length, 1);
      const row: unknown = selected[0];
      assert.ok(isRecord(row) && typeof row.sha256 === "string" && typeof row.bytes === "number");
      return row;
    };
    for (const name of ["tauri-driver.exe", "msedgedriver.exe"]) {
      const entry = member(`bin/${name}`);
      files.push(
        await copyStageFile(
          state,
          path.join(state.tools.root, "bin", name),
          path.join(readonly, name),
          128 * 1024 ** 2,
          String(entry.sha256),
        ),
      );
    }
    const registry = member("scripts/native-qualification-account-registry.ps1");
    files.push(
      await copyStageFile(
        state,
        path.join(state.tools.root, "scripts/native-qualification-account-registry.ps1"),
        path.join(readonly, "native-qualification-account-registry.ps1"),
        131072,
        String(registry.sha256),
      ),
    );
    files.push(
      await copyStageFile(
        state,
        candidate.package_path,
        path.join(readonly, "candidate.exe"),
        candidate.candidate.package.bytes,
        candidate.candidate.package.sha256,
      ),
    );
    if ("predecessor" in candidate && candidate.predecessor)
      files.push(
        await copyStageFile(
          state,
          candidate.predecessor.path,
          path.join(readonly, "predecessor.exe"),
          candidate.predecessor.bytes,
          candidate.predecessor.sha256,
        ),
      );
    const configuration = {
      schema_version: 1,
      broker_sid: state.owner.broker,
      account_sid: state.account.sid,
      account_name: "PortcoveNativeQual",
      profile_root: state.account.profile,
      work_root: work,
      capture_root: directory,
      helper_sha256: hash(
        await readControllerToolFile(
          path.join(state.tools.root, "scripts/native-qualification-account.cs.txt"),
          131072,
        ),
      ),
      controller_root: state.owner.bridge,
    };
    const configurationFile = path.join(directory, "bridge-configuration.json"),
      configurationBytes = await retain(configurationFile, configuration);
    files.push(configurationFile);
    const binding = {
      invocation_id: prepared.request.invocation_id,
      configuration_sha256: hash(configurationBytes),
      helper_sha256: configuration.helper_sha256,
      broker_pid: state.owner.pid,
      broker_created_filetime: state.owner.created,
      capture_root: directory,
      account_sid: state.account.sid,
      profile_root: state.account.profile,
      work_root: work,
      controller_root: state.owner.bridge,
      powershell: {
        path: windowsSourceSystemExecutables.powershell,
        sha256: hash(
          await readControllerToolFile(windowsSourceSystemExecutables.powershell, 32 * 1024 ** 2),
        ),
      },
      desktop_tools: {
        node: { path: state.tools.node, sha256: String(member("bin/node.exe").sha256) },
        tauri_driver: {
          path: path.join(readonly, "tauri-driver.exe"),
          sha256: String(member("bin/tauri-driver.exe").sha256),
        },
        webview_driver: {
          path: path.join(readonly, "msedgedriver.exe"),
          sha256: String(member("bin/msedgedriver.exe").sha256),
        },
      },
      hosted: {
        profile: hostedWindowsWorkerAbi,
        harness_root: state.prepared.root,
        registry_sha256: String(registry.sha256),
      },
    };
    const bindingFile = path.join(directory, "account-binding.json"),
      bindingBytes = await retain(bindingFile, binding);
    files.push(bindingFile);
    assert.equal(state.parent.configuration.purpose, "application");
    const workerRequest = inspectHostedWindowsWorkerRequest({
      schema_version: 1,
      abi: hostedWindowsWorkerAbi,
      stage: kind,
      binding: { path: bindingFile, sha256: hash(bindingBytes) },
      capture_root: directory,
      work_root: work,
      package: {
        path: path.join(readonly, "candidate.exe"),
        bytes: candidate.candidate.package.bytes,
        sha256: candidate.candidate.package.sha256,
        version: candidate.version,
      },
      predecessor:
        "predecessor" in candidate && candidate.predecessor
          ? { ...candidate.predecessor, path: path.join(readonly, "predecessor.exe") }
          : null,
      tools: {
        node: binding.desktop_tools.node,
        powershell: binding.powershell,
        git: {
          path: windowsSourceSystemExecutables.git,
          sha256: hash(await readControllerToolFile(windowsSourceSystemExecutables.git)),
        },
      },
      worker_sha256: selectedHostedNativePlatform(state.parent.configuration, "windows-x86_64")
        .producer.harness.sha256,
      remaining_milliseconds: Math.floor(state.deadline - performance.now() - 30000),
    });
    const workerInput = path.join(directory, "worker-input.json"),
      workerBytes = await retain(workerInput, workerRequest);
    files.push(workerInput);

    await recheck(state);
    if (kind === "payload-signing") await requireActualHostedNativeCandidate(candidateReceipt);
    else await requireActualHostedNativePostSignPayload(candidateReceipt);
    const receipt = Object.freeze({
      kind: "original-hosted-windows-stage",
      invocation_id: prepared.request.invocation_id,
      authority: "none",
    });
    state.stage = receipt;
    stages.set(receipt, {
      session,
      kind,
      candidate: candidateReceipt,
      parent: parentReceipt,
      prepared,
      directory,
      binding,
      bindingFile,
      bindingSha: hash(bindingBytes),
      files,
      custody: inspectNativeRuntimeCustody(files),
      host: observed.raw,
      hostNonce: state.binding,
      started: false,
      settled: false,
      stopped: false,
      station: null,
      workerRequestSha: hash(workerBytes),
    });
    await remember(state, files);
    active(state);
    return receipt;
  } catch (error) {
    await failSession(state, error);
    throw error;
  }
}

export async function startActualHostedWindowsStage(stageReceipt: object) {
  const stage = stages.get(stageReceipt);
  assert.ok(stage && !stage.stopped && !stage.started, "original unused Windows stage required");
  const state = sessions.get(stage.session);
  assert.ok(state && state.account);
  stage.started = true;
  try {
    await startWindowsOwnerStageMechanism(state, stage, {
      invocationId: stage.prepared.request.invocation_id,
      active: () => active(state),
      recheck: () => recheck(state),
      recheckStage: () => recheckNativeRuntimeCustody(stage.files, stage.custody),
      write: (name, value) => writeRequest(state, name, value),
      read: (name) => readOwner(state, name),
      workerRecord: (name) => readWorkerRecord(state, stage, name),
      remember: (files) => remember(state, files),
      inspectAccount: (enabled) => inspectOriginalHostedWindowsAccount(state, enabled),
      inspectLineage: (...args) => inspectChildLineage(state, ...args),
      frame: (file, value) => writeFramedFile(state, file, value),
    });
    return Object.freeze({
      prepared: stage.prepared,
      directory: stage.directory,
      bindingFile: stage.bindingFile,
      bindingSha: stage.bindingSha,
      host: stage.host,
      hostNonce: stage.hostNonce,
      source_root: state.prepared.root,
      tools: state.tools,
      runtime: state.prepared.runtime,
      parent: stage.parent,
      deadline: state.deadline,
      authority: "none",
    });
  } catch (error) {
    stage.stopped = true;
    await failSession(state, error);
    throw error;
  }
}

export async function settleActualHostedWindowsStage(stageReceipt: object) {
  const stage = stages.get(stageReceipt);
  assert.ok(stage && stage.started && !stage.settled && !stage.stopped);
  const state = sessions.get(stage.session);
  assert.ok(state && state.account);
  try {
    await settleWindowsOwnerStageMechanism(state, stage, {
      invocationId: stage.prepared.request.invocation_id,
      active: () => active(state),
      recheck: () => recheck(state),
      recheckStage: () => recheckNativeRuntimeCustody(stage.files, stage.custody),
      write: (name, value) => writeRequest(state, name, value),
      read: (name) => readOwner(state, name),
      workerRecord: (name) => readWorkerRecord(state, stage, name),
      remember: (files) => remember(state, files),
      inspectAccount: (enabled) => inspectOriginalHostedWindowsAccount(state, enabled),
      inspectLineage: (...args) => inspectChildLineage(state, ...args),
      frame: (file, value) => writeFramedFile(state, file, value),
      station: (before) => verifyStationRestored(state, before),
    });
    stage.settled = true;
    state.phase = stage.kind === "payload-signing" ? "await-post" : "finished";
    return Object.freeze({
      directory: stage.directory,
      prepared: stage.prepared,
      host: stage.host,
      hostNonce: stage.hostNonce,
      authority: "none",
    });
  } catch (error) {
    stage.stopped = true;
    await failSession(state, error);
    throw error;
  }
}

async function verifyStationRestored(state: State, before: Buffer) {
  recheckWindowsSourceSystemCustody(state.prepared.system_custody);
  const source = path.join(state.root, "original-station-readback.cs.txt"),
    encoded = Buffer.from(source).toString("base64");
  const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$b=[IO.File]::ReadAllBytes($p);if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() -cne '${hash(state.setupSource)}'){throw 'Original readback helper changed'};Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString($b));[Convert]::ToBase64String([Portcove.HostedNative.HostedDesktop]::ReadCurrentStation())`;
  const output = execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: state.root,
      env: ownerEnvironment(state.root),
      encoding: "utf8",
      timeout: Math.max(1, Math.min(15000, Math.floor(state.deadline - performance.now()))),
      maxBuffer: 32768,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  assert.ok(
    Buffer.from(output, "base64").equals(before),
    "independent station restoration readback differs",
  );
}

/** Cleanup of this original owned attempt only. Never adoption, retry or native credit. */
export async function recoverActualHostedWindowsSession(session: object) {
  const state = sessions.get(session);
  assert.ok(state, "original Windows session required for recovery");
  return recoverState(state);
}
async function recoverState(state: State) {
  assert.ok(!state.recoveryAttempted, "one original recovery attempt; retain prior receipts");
  state.recoveryAttempted = true;
  state.stopped = true;
  state.signal.emit("SIGTERM");
  // Resolution proves original supervisor settlement; rejection retains Unknown custody.
  await state.running;
  const observedOwner = readWindowsNativeProcessFiletime(state.owner.pid, state.deadline);
  assert.notEqual(
    observedOwner,
    state.owner.created,
    "original owner still live; retain without competing recovery",
  );
  const directory = path.join(state.root, "recovery");
  await mkdir(directory);
  const stage = state.stage ? stages.get(state.stage) : undefined;
  let station = stage?.station ?? null,
    partial: string | null = null;
  if (stage?.started && !station) {
    try {
      station = {
        before: await readControllerToolFile(
          path.join(stage.directory, "station-dacl-before.bin"),
          16384,
        ),
        proposed: await readControllerToolFile(
          path.join(stage.directory, "station-dacl-proposed.bin"),
          16384,
        ),
      };
    } catch {
      partial = "station proposal/preimage unavailable; restoration remains Unknown";
    }
  }
  const record = {
    binding: state.binding,
    account_sid: state.account?.sid ?? null,
    description: state.account?.description ?? null,
    broker_sid: state.owner.broker,
    original_owner_pid: state.owner.pid,
    original_owner_created_filetime: state.owner.created,
    setup_sha256: hash(state.setupSource),
    station: station
      ? {
          before_base64: station.before.toString("base64"),
          proposed_base64: station.proposed.toString("base64"),
        }
      : null,
  };
  await retain(path.join(directory, "recovery-intent.json"), {
    binding: state.binding,
    account_sid: state.account?.sid ?? null,
    partial,
    automatic_retry: false,
    authority: "none",
  });
  if (!state.account || performance.now() >= state.parent.deadline) {
    await retain(path.join(directory, "recovery-refused.json"), {
      reason: !state.account
        ? "original account ownership not established"
        : "original cleanup budget exhausted",
      partial,
      authority: "none",
    });
    throw new Error(
      "Original recovery unavailable; retain partial state for explicit owning recovery",
    );
  }
  for (const [name, bytes] of [
    ["release-hosted-native-windows-setup.cs.txt", state.setupSource],
    ["recovery.ps1", state.recoverySource],
  ] as const) {
    const handle = await open(
      path.join(directory, name),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_SYNC,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    assert.ok((await readControllerToolFile(path.join(directory, name), 131072)).equals(bytes));
  }
  const input = path.join(directory, "recovery-context.json"),
    bytes = await retain(input, record);
  recheckWindowsSourceSystemCustody(state.prepared.system_custody);
  execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(directory, "recovery.ps1"),
      "-Context",
      input,
      "-ExpectedSha256",
      hash(bytes),
    ],
    {
      cwd: directory,
      env: ownerEnvironment(state.root),
      timeout: Math.max(1, Math.min(30000, Math.floor(state.deadline - performance.now()))),
      maxBuffer: 16384,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output: unknown = JSON.parse(
    (await readControllerToolFile(path.join(directory, "recovery-result.json"), 16384)).toString(
      "utf8",
    ),
  );
  assert.ok(
    isRecord(output) &&
      output.binding === state.binding &&
      output.account_sid === state.account.sid &&
      output.disabled === true,
  );
  await inspectOriginalHostedWindowsAccount(state, false);
  if (station) {
    assert.equal(output.station_restored, true);
    await verifyStationRestored(state, station.before);
  }
  assert.equal(partial, null, "partial station recovery cannot become complete settlement");
  return Object.freeze({
    directory,
    scope: "exact original recovery; no native acceptance",
    authority: "none",
  });
}

/** Failure only: a downstream capture/upload refusal stops the original owner and recovery once. */
export async function refuseActualHostedWindowsSession(receipt: object, error: unknown) {
  const state = sessions.get(receipt);
  assert.ok(state, "Original Windows session required to refuse execution");
  await failSession(state, error);
}

async function failSession(state: State, error: unknown) {
  state.stopped = true;
  state.signal.emit("SIGTERM");
  await retain(path.join(state.root, "session-failure.json"), {
    binding: state.binding,
    failure: error instanceof Error ? error.message.slice(0, 1024) : "session refused",
    automatic_retry: false,
    authority: "none",
  }).catch(() => {});
  if (!state.recoveryAttempted) {
    try {
      await recoverState(state);
    } catch (recovery) {
      await retain(path.join(state.root, "recovery-unavailable.json"), {
        binding: state.binding,
        failure:
          recovery instanceof Error ? recovery.message.slice(0, 1024) : "original recovery refused",
        availability: "Unknown",
        automatic_retry: false,
        authority: "none",
      }).catch(() => {});
    }
  }
}

export async function requireActualHostedWindowsStage(receipt: object) {
  const stage = stages.get(receipt);
  assert.ok(stage && !stage.stopped, "original hosted Windows stage required");
  const state = sessions.get(stage.session);
  assert.ok(state);
  try {
    await recheck(state);
    recheckNativeRuntimeCustody(stage.files, stage.custody);
    if (stage.settled) {
      await inspectOriginalHostedWindowsAccount(state, false);
      assert.ok(stage.station);
      await verifyStationRestored(state, stage.station.before);
    }
    active(state);
    return Object.freeze({
      session: stage.session,
      kind: stage.kind,
      prepared: stage.prepared,
      directory: stage.directory,
      binding: structuredClone(stage.binding),
      bindingFile: stage.bindingFile,
      bindingSha: stage.bindingSha,
      host: structuredClone(stage.host),
      hostNonce: stage.hostNonce,
      started: stage.started,
      settled: stage.settled,
      source_root: state.prepared.root,
      candidate: stage.candidate,
      tools: state.prepared.tools,
      tool_paths: state.tools,
      system_custody: new Map(state.prepared.system_custody),
      runtime: state.prepared.runtime,
      parent: stage.parent,
      deadline: state.deadline,
      authority: "none",
    });
  } catch (error) {
    stage.stopped = true;
    await failSession(state, error);
    throw error;
  }
}
async function recheckTerminalSettlement(state: State) {
  const current = () => {
    assertControllerBootstrapEnvironment();
    state.parent.recheck();
    assert.ok(
      !state.stopped &&
        state.status === 0 &&
        state.error === undefined &&
        performance.now() < state.deadline,
      "Original terminal settlement expired or revoked",
    );
  };
  current();
  recheckNativeRuntimeCustody(state.files, state.custody);
  await requireActualHostedWindowsDependencies(state.prepared.dependencies);
  const runtime = await requireHostedNativeRuntime(state.prepared.runtime, state.prepared.parent);
  state.deadline = Math.min(state.deadline, runtime.deadline);
  await requireActualHostedNativeParentSource(state.prepared.parent);
  if (state.postParent) await requireActualHostedNativeParentSource(state.postParent);
  recheckNativeRuntimeCustody(state.files, state.custody);
  current();
  const identity = readWindowsNativeProcessFiletime(state.owner.pid, state.deadline);
  assert.notEqual(identity, state.owner.created, "Original owner exit unobserved");
  current();
}
export async function finishActualHostedWindowsSession(receipt: object) {
  const state = sessions.get(receipt);
  assert.ok(
    state && state.phase === "finished" && !state.stopped,
    "both original Windows stages must settle before owner finish",
  );
  try {
    await recheck(state);
    writeRequest(state, "owner-finish.json", {});
    assert.equal(await state.running, 0, "original credential owner did not exit successfully");
    const file = path.join(state.root, "owner-final.json"),
      record: unknown = JSON.parse((await readControllerToolFile(file, 16384)).toString("utf8"));
    assert.ok(
      isRecord(record) &&
        record.binding === state.binding &&
        record.owner_pid === state.owner.pid &&
        record.owner_created_filetime === state.owner.created &&
        record.failure === "" &&
        Array.isArray(record.cleanup_failures) &&
        record.cleanup_failures.length === 0 &&
        record.credential_disposed === true,
    );
    await recheckTerminalSettlement(state);
    await inspectOriginalHostedWindowsAccount(state, false);
    await recheckTerminalSettlement(state);
    state.stopped = true;
    return Object.freeze({
      directory: state.root,
      deadline: state.deadline,
      scope: "original credential disposal and account settlement; no new native acceptance",
      authority: "none",
    });
  } catch (error) {
    await failSession(state, error);
    throw error;
  }
}

export async function prepareActualHostedWindowsPreSignStage(session: object) {
  const state = sessions.get(session);
  assert.ok(state && !state.preAttempted, "one original Windows pre-stage attempt");
  state.preAttempted = true;
  return prepareStage(session, "payload-signing", state.prepared.candidate, state.prepared.parent);
}
export async function prepareActualHostedWindowsPostSignStage(session: object) {
  const state = sessions.get(session);
  assert.ok(state && state.phase === "await-post", "original pre-stage settlement required");
  state.phase = "post";
  try {
    await recheck(state);
    const parent = await createActualHostedNativeParentSource(
      state.root,
      "windows-x86_64",
      "release-publication",
      state.deadline,
    );
    await joinHostedWindowsPostSignRuntime(state.prepared.runtime, state.prepared.parent, parent);
    state.postParent = parent;
    await recheck(state);
    const full = hostedWindowsOwnerDeadline(
        state.clockSample,
        state.frequency,
        state.deadline,
        state.clockReceived,
      ),
      activeTicks = (BigInt(full) - 30n * BigInt(state.frequency)).toString();
    assert.ok(BigInt(activeTicks) <= BigInt(state.activeTicks));
    state.activeTicks = activeTicks;
    const source = await readActualHostedNativePostSignController(parent),
      inputs = await acquireActualHostedNativePostSignInputs(
        source,
        state.prepared.tools,
        state.prepared.runtime,
      ),
      journey = await readActualHostedNativePostSignJourney(inputs),
      pkg = await acquireActualHostedNativePostSignPackage(journey),
      payload = await verifyActualHostedNativePostSignPayload(pkg);
    await recheck(state);
    return await prepareStage(session, "release-publication", payload, parent);
  } catch (error) {
    await failSession(state, error);
    throw error;
  }
}
