/** One separately held, unbranded diagnostic invocation of the original A/B OS
 * machinery. This module cannot construct protected candidate or native receipts. */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open, lstat, writeFile } from "node:fs/promises";
import { openSync, closeSync, constants, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord, errorCode } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import {
  nativeRuntimeSupportProfile,
  inspectNativeRuntimeSupport,
  preparedNativeSupportDependencies,
} from "./release-native-runtime-support.mts";
import {
  controllerBootstrapEnvironment,
  materializeControllerNativeSupport,
} from "./release-controller-tool-build.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  inspectWindowsSourceSystemCustody,
  recheckWindowsSourceSystemCustody,
  windowsSourceSystemExecutables,
} from "./release-native-runtime-custody.mts";
import {
  inspectHostedWindowsWorkerRequest,
  hostedWindowsWorkerAbi,
} from "./release-hosted-native-windows-worker-contract.mts";
import { hashNativeCapturedFile } from "./release-native-capture-files.mts";
import {
  windowsOwnerEnvironment,
  windowsOwnerFiletime,
  captureWindowsOwnerSupervisor,
  writeWindowsOwnerFrame,
  readWindowsOwnerRecord,
  readWindowsOwnerWorkerRecord,
  copyWindowsOwnerStageFile,
  establishWindowsOwnerAccount,
  startWindowsOwnerStageMechanism,
  settleWindowsOwnerStageMechanism,
  type WindowsOwnerMechanismState,
} from "./release-windows-owner-mechanism.mts";
import {
  readOriginalHostedWindowsDiagnosticInputs,
  requireOriginalHostedWindowsDiagnosticContext,
  readOrdinaryHostedWindowsDiagnosticDeadline,
  readBoundedDiagnosticProviderBody,
} from "./release-hosted-native-windows-diagnostic-source.mts";
import {
  readHostedWindowsDiagnosticUploadRequest,
  acknowledgeHostedWindowsDiagnosticUpload,
  awaitOriginalNativeUploadAcknowledgment,
} from "./release-hosted-native-runner.mts";

export const hostedWindowsConnectedDiagnosticExecutionAuthorized = true;
const project = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const diagnosticRoot = path.join(project, "work/hosted-windows-connected-diagnostic");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Inputs = Awaited<ReturnType<typeof readOriginalHostedWindowsDiagnosticInputs>>;
type Kind = "payload-signing" | "release-publication";
type Stage = {
  kind: Kind;
  directory: string;
  binding: Record<string, unknown>;
  workerRequestSha: string;
  bindingSha: string;
  station: { before: Buffer; proposed: Buffer } | null;
  worker?: { pid: number; created: string };
  invocation: string;
  files: string[];
  custody: ReturnType<typeof inspectNativeRuntimeCustody>;
  package: { version: string; bytes: number; sha256: string };
  predecessor: { version: string; bytes: number; sha256: string } | null;
  publicRoot: string;
};
type State = WindowsOwnerMechanismState & {
  tools: { root: string; node: string };
  inputs: Inputs;
  status: number | undefined;
  running: Promise<number>;
  stopped: boolean;
  sequence: number;
  files: string[];
  custody: ReturnType<typeof inspectNativeRuntimeCustody>;
  system: ReturnType<typeof inspectWindowsSourceSystemCustody>;
  setup: Buffer;
  recovery: Buffer;
  stage?: Stage;
  recoveryAttempted: boolean;
};
function held() {
  assert.ok(
    hostedWindowsConnectedDiagnosticExecutionAuthorized,
    "Connected Windows diagnostic awaits exact new source/account/candidate/recovery authority",
  );
  requireOriginalHostedWindowsDiagnosticContext();
}
function environment(root: string) {
  return {
    ...windowsOwnerEnvironment(root),
    GITHUB_SHA: process.env.GITHUB_SHA,
    GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
  };
}
async function retain(file: string, value: unknown, maximum = 16384) {
  const bytes = Buffer.from(JSON.stringify(value));
  assert.ok(bytes.length > 0 && bytes.length <= maximum);
  const f = await open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_SYNC,
    0o600,
  );
  try {
    await f.writeFile(bytes);
    await f.sync();
  } finally {
    await f.close();
  }
  return bytes;
}
function active(state: State) {
  held();
  assert.equal(
    existsSync(path.join(controlRoot(), "abort-request.json")),
    false,
    "Original diagnostic abort requested; exact recovery only",
  );
  assert.ok(
    !state.stopped &&
      state.status === undefined &&
      state.error === undefined &&
      performance.now() < state.deadline,
    "Original diagnostic controller stopped or expired",
  );
  assert.equal(process.env.GITHUB_SHA, state.inputs.source);
  assert.equal(process.env.GITHUB_RUN_ID, state.inputs.run_id);
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
  assert.equal(process.env.GITHUB_WORKFLOW_REF, state.inputs.workflow);
  assert.equal(process.env.PORTCOVE_HOSTED_OBSERVATION_ONLY, "false");
}
function os(state: State, script: string, maximum = 16384) {
  recheckWindowsSourceSystemCustody(state.system);
  assert.ok(performance.now() < state.deadline);
  return execFileSync(
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
      env: environment(state.root),
      encoding: "utf8",
      maxBuffer: maximum,
      timeout: Math.max(1, Math.min(15000, Math.floor(state.deadline - performance.now()))),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
async function recheck(state: State) {
  active(state);
  const gitEnvironment = {
    ...environment(state.root),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[]) =>
    execFileSync(windowsSourceSystemExecutables.git, args, {
      cwd: project,
      env: gitEnvironment,
      encoding: "utf8",
      timeout: Math.max(1, Math.min(10000, Math.floor(state.deadline - performance.now()))),
      maxBuffer: 65536,
      windowsHide: true,
    }).trim();
  assert.equal(git(["rev-parse", "HEAD"]), state.inputs.source);
  assert.equal(git(["rev-parse", "HEAD^{tree}"]), state.inputs.tree);
  git(["-c", "core.fsmonitor=false", "diff", "--quiet", "HEAD", "--"]);

  recheckNativeRuntimeCustody(state.files, state.custody);
  recheckNativeRuntimeCustody(state.inputs.drivers.files, state.inputs.drivers.custody);
  recheckWindowsSourceSystemCustody(state.system);
  const identity = readProcessIdentity(state.owner.pid);
  if (state.owner.pid)
    assert.equal(windowsOwnerFiletime(identity, state.owner.pid), state.owner.created);
  active(state);
}
async function remember(state: State, files: string[]) {
  active(state);
  recheckNativeRuntimeCustody(state.files, state.custody);
  assert.ok(files.every((f) => !state.files.includes(f)));
  const next = [...state.files, ...files],
    custody = inspectNativeRuntimeCustody(next);
  for (const [file, value] of state.custody)
    assert.equal(custody.get(file), value, "Original diagnostic custody cannot rebase");
  state.files = next;
  state.custody = custody;
  active(state);
}
function frame(state: State, file: string, value: Record<string, unknown>) {
  active(state);
  recheckWindowsSourceSystemCustody(state.system);
  writeWindowsOwnerFrame(file, value, {
    root: state.root,
    deadline: state.deadline,
    powershell: windowsSourceSystemExecutables.powershell,
    environment: environment(state.root),
  });
  active(state);
}
function request(state: State, name: string, value: Record<string, unknown>) {
  frame(state, path.join(state.root, name), {
    ...value,
    binding: state.binding,
    owner_pid: state.owner.pid,
    owner_created_filetime: state.owner.created,
    sequence: state.sequence,
  });
  state.sequence++;
}
function read(state: State, name: string) {
  return readWindowsOwnerRecord(
    { root: state.root, binding: state.binding, active: () => active(state) },
    name,
  );
}
async function account(state: State, enabled: boolean) {
  assert.ok(state.account);
  const expected = Buffer.from(
    JSON.stringify({ sid: state.account.sid, description: state.account.description, enabled }),
  ).toString("base64");
  const value: unknown = JSON.parse(
    os(
      state,
      `$ErrorActionPreference='Stop';$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}'))|ConvertFrom-Json;$u=Get-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($v.sid));if($u.Name -cne 'PortcoveNativeQual' -or $u.Description -cne $v.description -or $u.Enabled -ne $v.enabled){throw 'Original diagnostic account OS state differs'};@{sid=$u.SID.Value;broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;enabled=$u.Enabled}|ConvertTo-Json -Compress`,
    ),
  );
  assert.ok(
    isRecord(value) &&
      value.sid === state.account.sid &&
      value.broker === state.owner.broker &&
      value.enabled === enabled,
  );
}
async function lineage(state: State, pid: number, created: string, parent: number, image: string) {
  active(state);
  assert.equal(windowsOwnerFiletime(readProcessIdentity(pid), pid), created);
  const value: unknown = JSON.parse(
    os(
      state,
      `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -OperationTimeoutSec 5;@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;image=$p.ExecutablePath}|ConvertTo-Json -Compress`,
    ),
  );
  assert.ok(
    isRecord(value) &&
      value.pid === pid &&
      value.parent === parent &&
      typeof value.image === "string" &&
      value.image.toLowerCase() === image.toLowerCase(),
  );
  assert.equal(windowsOwnerFiletime(readProcessIdentity(pid), pid), created);
  active(state);
}
async function station(state: State, before: Buffer) {
  const encoded = state.setup.toString("base64"),
    output = os(
      state,
      `$ErrorActionPreference='Stop';$b=[Convert]::FromBase64String('${encoded}');Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString($b));[Convert]::ToBase64String([Portcove.HostedNative.HostedDesktop]::ReadCurrentStation())`,
      32768,
    );
  assert.ok(
    Buffer.from(output, "base64").equals(before),
    "Independent diagnostic station restoration differs",
  );
}
async function freshTools(inputs: Inputs, deadline: number) {
  const setup = await readControllerToolFile(
    path.join(project, "scripts/release-hosted-native-windows-setup.cs.txt"),
    131072,
  );
  const data = Buffer.from(
    JSON.stringify({ root: diagnosticRoot, source: setup.toString("base64") }),
  ).toString("base64");
  execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference='Stop';$v=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json;Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($v.source)));$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;[Portcove.HostedNative.Setup]::Directory($v.root,$owner,'',$false);foreach($name in @('tools','owner')){[Portcove.HostedNative.Setup]::Directory((Join-Path $v.root $name),$owner,'',$false)}`,
        "utf16le",
      ).toString("base64"),
    ],
    {
      cwd: project,
      env: environment(project),
      timeout: 15000,
      maxBuffer: 16384,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const tools = path.join(diagnosticRoot, "tools"),
    assets = [
      "release-hosted-native-windows-owner.ps1",
      "release-hosted-native-windows-owner-mechanism.ps1",
      "release-hosted-native-windows-diagnostic-owner.ps1",
      "release-hosted-native-windows-recovery.ps1",
      "release-hosted-native-windows-setup.cs.txt",
      "native-qualification-account.cs.txt",
      "native-qualification-account-bridge.ps1",
      "native-qualification-account-client.ps1",
      "native-qualification-account-registry.ps1",
    ];
  const files: { path: string; bytes: number; sha256: string }[] = [];
  for (const directory of ["scripts", "bin", "home", "target"])
    await mkdir(path.join(tools, directory), { mode: 0o700 });
  const copy = async (source: string, name: string, maximum: number) => {
    const bytes = await readControllerToolFile(source, maximum);
    await copyWindowsOwnerStageFile(
      { active: () => assert.ok(performance.now() < deadline) },
      source,
      path.join(tools, name),
      maximum,
      hash(bytes),
    );
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  };
  for (const asset of assets)
    await copy(path.join(project, "scripts", asset), "scripts/" + asset, 131072);
  await copy(process.execPath, "bin/node.exe", 128 * 1024 ** 2);
  await copy(inputs.drivers.native.path, "bin/msedgedriver.exe", 64 * 1024 ** 2);
  await copy(inputs.drivers.tauri.path, "bin/tauri-driver.exe", 128 * 1024 ** 2);
  const support = nativeRuntimeSupportProfile("windows-x86_64");
  await mkdir(path.dirname(path.join(tools, support.source)), { recursive: true });
  await copy(path.join(project, support.source), support.source, 65536);
  await materializeControllerNativeSupport(
    project,
    tools,
    controllerBootstrapEnvironment(path.join(tools, "home"), path.join(tools, "target")),
    "windows-x86_64",
  );
  for (const name of [support.binary, support.metadata]) {
    const bytes = await readControllerToolFile(
      path.join(tools, name),
      name === support.metadata ? 65536 : support.maximumBinaryBytes,
    );
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  await retain(
    path.join(tools, "manifest.json"),
    {
      schema_version: 1,
      source: inputs.source,
      tree: inputs.tree,
      files,
      scope: "unbranded connected diagnostic OS tools only",
      authority: "none",
    },
    65536,
  );
  return { tools, files, setup, support };
}
function stageOptions(state: State, stage: Stage) {
  return {
    invocationId: stage.invocation,
    active: () => active(state),
    recheck: () => recheck(state),
    recheckStage: () => recheckNativeRuntimeCustody(stage.files, stage.custody),
    write: (name: string, value: Record<string, unknown>) => request(state, name, value),
    read: (name: string) => read(state, name),
    workerRecord: (name: "worker-ready" | "worker-result") =>
      readWindowsOwnerWorkerRecord({ active: () => active(state) }, stage.directory, name),
    remember: (files: string[]) => remember(state, files),
    inspectAccount: (enabled: boolean) => account(state, enabled),
    inspectLineage: (...args: [number, string, number, string]) => lineage(state, ...args),
    frame: (file: string, value: Record<string, unknown>) => frame(state, file, value),
    station: (before: Buffer) => station(state, before),
  };
}
async function prepareStage(state: State, kind: Kind): Promise<Stage> {
  await recheck(state);
  assert.ok(state.account);
  request(state, kind + "-prepare.json", { active_deadline_ticks: state.activeTicks });
  const paths = await read(state, kind + "-prepared.json"),
    root = path.join(state.root, kind),
    directory = path.join(root, "capture"),
    readonly = path.join(root, "readonly"),
    work = path.join(root, "work");
  assert.equal(paths.value.stage, kind);
  assert.equal(paths.value.capture_root, directory);
  assert.equal(paths.value.readonly_root, readonly);
  assert.equal(paths.value.work_root, work);
  const manifest: unknown = JSON.parse(
    (await readControllerToolFile(path.join(state.tools.root, "manifest.json"), 65536)).toString(
      "utf8",
    ),
  );
  assert.ok(isRecord(manifest) && Array.isArray(manifest.files));
  const rows: unknown[] = manifest.files;
  const member = (name: string) => {
    const found = rows.filter((row: unknown) => isRecord(row) && row.path === name);
    assert.equal(found.length, 1);
    const row: unknown = found[0];
    assert.ok(isRecord(row) && typeof row.sha256 === "string" && Number.isSafeInteger(row.bytes));
    return { sha256: row.sha256, bytes: Number(row.bytes) };
  };
  const files = [paths.file];
  const copy = async (source: string, target: string, maximum: number, sha256: string) => {
    files.push(
      await copyWindowsOwnerStageFile(
        { active: () => active(state) },
        source,
        target,
        maximum,
        sha256,
      ),
    );
  };
  for (const name of ["tauri-driver.exe", "msedgedriver.exe"])
    await copy(
      path.join(state.tools.root, "bin", name),
      path.join(readonly, name),
      128 * 1024 ** 2,
      member("bin/" + name).sha256,
    );
  const registry = member("scripts/native-qualification-account-registry.ps1");
  await copy(
    path.join(state.tools.root, "scripts/native-qualification-account-registry.ps1"),
    path.join(readonly, "native-qualification-account-registry.ps1"),
    131072,
    registry.sha256,
  );
  const candidate = state.inputs.stages[1]!,
    prior = kind === "release-publication" ? state.inputs.stages[0]! : null,
    pkg = candidate.inventory.updater;
  const candidateIdentity = await hashNativeCapturedFile(
    project,
    path.relative(project, candidate.package_path),
    512 * 1024 ** 2,
    state.deadline,
  );
  assert.equal(candidateIdentity.sha256, pkg.sha256);
  assert.equal(candidateIdentity.bytes, pkg.bytes);
  await copy(candidate.package_path, path.join(readonly, "candidate.exe"), pkg.bytes, pkg.sha256);
  if (prior)
    await copy(
      prior.package_path,
      path.join(readonly, "predecessor.exe"),
      prior.inventory.updater.bytes,
      prior.inventory.updater.sha256,
    );
  const invocation = hash(
    Buffer.from(
      JSON.stringify({
        source: state.inputs.source,
        tree: state.inputs.tree,
        run_id: state.inputs.run_id,
        attempt: 1,
        stage: kind,
        package: pkg.sha256,
        owner: state.owner,
        binding: state.binding,
        scope: "connected diagnostic only",
      }),
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
    helper_sha256: member("scripts/native-qualification-account.cs.txt").sha256,
    controller_root: state.owner.bridge,
  };
  const configurationFile = path.join(directory, "bridge-configuration.json"),
    configurationBytes = await retain(configurationFile, configuration);
  files.push(configurationFile);
  const binding = {
    invocation_id: invocation,
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
      node: { path: state.tools.node, sha256: member("bin/node.exe").sha256 },
      tauri_driver: {
        path: path.join(readonly, "tauri-driver.exe"),
        sha256: member("bin/tauri-driver.exe").sha256,
      },
      webview_driver: {
        path: path.join(readonly, "msedgedriver.exe"),
        sha256: member("bin/msedgedriver.exe").sha256,
      },
    },
    hosted: {
      profile: hostedWindowsWorkerAbi,
      harness_root: project,
      registry_sha256: registry.sha256,
    },
  };
  const bindingFile = path.join(directory, "account-binding.json"),
    bindingBytes = await retain(bindingFile, binding);
  files.push(bindingFile);
  const worker = inspectHostedWindowsWorkerRequest({
    schema_version: 1,
    abi: hostedWindowsWorkerAbi,
    stage: kind,
    binding: { path: bindingFile, sha256: hash(bindingBytes) },
    capture_root: directory,
    work_root: work,
    package: {
      path: path.join(readonly, "candidate.exe"),
      bytes: pkg.bytes,
      sha256: pkg.sha256,
      version: candidate.version,
    },
    predecessor: prior
      ? {
          path: path.join(readonly, "predecessor.exe"),
          bytes: prior.inventory.updater.bytes,
          sha256: prior.inventory.updater.sha256,
          version: prior.version,
        }
      : null,
    tools: {
      node: binding.desktop_tools.node,
      powershell: binding.powershell,
      git: {
        path: windowsSourceSystemExecutables.git,
        sha256: hash(await readControllerToolFile(windowsSourceSystemExecutables.git)),
      },
    },
    worker_sha256: hash(
      await readControllerToolFile(path.join(project, "scripts/release-native-worker.mts"), 131072),
    ),
    remaining_milliseconds: Math.max(1, Math.floor(state.deadline - performance.now() - 30000)),
  });
  const workerInput = path.join(directory, "worker-input.json"),
    workerBytes = await retain(workerInput, worker, 32768);
  files.push(workerInput);
  await remember(state, files);
  await recheck(state);
  return {
    kind,
    directory,
    binding,
    workerRequestSha: hash(workerBytes),
    bindingSha: hash(bindingBytes),
    station: null,
    invocation,
    files,
    custody: inspectNativeRuntimeCustody(files),
    package: { version: candidate.version, bytes: pkg.bytes, sha256: pkg.sha256 },
    predecessor: prior
      ? {
          version: prior.version,
          bytes: prior.inventory.updater.bytes,
          sha256: prior.inventory.updater.sha256,
        }
      : null,
    publicRoot: path.join(root, "public"),
  };
}
async function diagnosticPublicCapture(state: State, stage: Stage) {
  await recheck(state);
  assert.ok(state.account);
  const bytes = await readControllerToolFile(
      path.join(stage.directory, "installer.json"),
      4 * 1024 ** 2,
    ),
    installer: unknown = JSON.parse(bytes.toString("utf8"));
  assert.ok(
    isRecord(installer) &&
      installer.format === 1 &&
      installer.phase === "complete" &&
      installer.failure === null &&
      isRecord(installer.observation_identity) &&
      isRecord(installer.package_inputs) &&
      isRecord(installer.details),
  );
  assert.equal(installer.observation_identity.source_commit, state.inputs.source);
  assert.equal(installer.observation_identity.source_tree, state.inputs.tree);
  assert.equal(
    installer.observation_identity.harness_sha256,
    hash(
      await readControllerToolFile(
        path.join(project, "scripts/test-windows-installer.ps1"),
        512 * 1024,
      ),
    ),
  );
  assert.equal(installer.package_inputs.installer_sha256, stage.package.sha256);
  assert.equal(
    installer.package_inputs.predecessor_installer_sha256,
    stage.predecessor?.sha256 ?? null,
  );
  const details = installer.details;
  assert.equal(details.registered_version, stage.package.version);
  assert.equal(details.registration_account_sid, state.account.sid);
  assert.equal(details.application_responding, true);
  for (const name of ["persistent_data_preserved", "managed_files_removed", "registration_removed"])
    assert.equal(details[name], true);
  if (stage.predecessor) {
    assert.ok(isRecord(details.package_rollback));
    assert.equal(details.package_rollback.registered_version, stage.predecessor.version);
    assert.equal(details.package_rollback.registration_account_sid, state.account.sid);
  }
  const captures = [];
  for (const name of [
    "installer.json",
    "worker-ready.json",
    "worker-ready.complete",
    "worker-result.json",
    "worker-result.complete",
    "harness.stdout.bin",
    "harness.stderr.bin",
    "station-dacl-before.bin",
    "station-dacl-proposed.bin",
  ]) {
    captures.push(
      await hashNativeCapturedFile(
        stage.directory,
        name,
        name === "installer.json" ? 4 * 1024 ** 2 : 65536,
        state.deadline,
      ),
    );
  }
  await mkdir(stage.publicRoot, { mode: 0o700 });
  const records = {
    subject: {
      schema_version: 1,
      scope: "nonproduction connected private-session candidate observation only",
      source: state.inputs.source,
      tree: state.inputs.tree,
      run_id: state.inputs.run_id,
      attempt: 1,
      workflow: state.inputs.workflow,
      stage: stage.kind,
      invocation_id: stage.invocation,
      package: stage.package,
      predecessor: stage.predecessor,
      driver: { native: state.inputs.drivers.native, tauri: state.inputs.drivers.tauri },
      runtime: { observed: state.inputs.runtime.observed, minimum: state.inputs.runtime.minimum },
      authority: "none",
    },
    report: {
      schema_version: 1,
      source: state.inputs.source,
      stage: stage.kind,
      observation_identity: installer.observation_identity,
      package_inputs: installer.package_inputs,
      observations: {
        registration_account_sid: details.registration_account_sid,
        registered_version: details.registered_version,
        installed_executable_sha256: details.installed_executable_sha256,
        application_responding: details.application_responding,
        persistent_data_preserved: details.persistent_data_preserved,
        managed_files_removed: details.managed_files_removed,
        registration_removed: details.registration_removed,
        signature_status: details.signature_status,
        package_rollback: details.package_rollback,
      },
      cleanup: {
        account_disabled: true,
        station_restored: true,
        group_empty: true,
        output_drained: true,
      },
      production_acceptance: "not-established",
      authority: "none",
    },
    capture: {
      schema_version: 1,
      files: captures,
      original_owner: state.owner,
      account_sid: state.account.sid,
      authority: "none",
    },
  };
  const files = [];
  for (const [name, value] of Object.entries(records)) {
    const file = path.join(stage.publicRoot, name + ".json"),
      raw = await retain(file, value, 131073);
    files.push({ path: file, bytes: raw.length, sha256: hash(raw) });
  }
  const bundleFile = path.join(stage.publicRoot, "bundle.json"),
    bundle = await retain(
      bundleFile,
      {
        schema_version: 1,
        files: files.map((row) => ({ ...row, path: path.basename(row.path) })),
        authority: "none",
        scope: "diagnostic public correlation only; no signed production subject",
      },
      131073,
    );
  files.push({ path: bundleFile, bytes: bundle.length, sha256: hash(bundle) });
  const name = `hosted-native-diagnostic-${stage.kind}-windows-x86_64-${state.inputs.run_id}-1`,
    ready = path.join(stage.publicRoot, "native-upload-ready.json");
  await retain(
    ready,
    {
      schema_version: 1,
      name,
      files,
      retention_days: 7,
      overwrite: false,
      compression_level: 0,
      authority: "none",
    },
    8192,
  );
  const { acknowledgement } = await awaitOriginalNativeUploadAcknowledgment({
    root: stage.publicRoot,
    originalDeadline: state.deadline,
    uploadDeadline: state.deadline - 30000,
    readyFile: ready,
    stage: stage.kind,
    platform: "windows-x86_64",
    diagnostic: true,
    recheck: () => recheck(state),
    phase: () => {},
  });
  const provider = await fetch(
    `https://api.github.com/repos/boburning/portcove/actions/artifacts/${String(acknowledgement.artifact_id)}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(10000, Math.floor(state.deadline - performance.now()))),
      ),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "portcove-fixed-connected-diagnostic",
      },
    },
  );
  assert.equal(provider.status, 200);
  const text = (
    await readBoundedDiagnosticProviderBody(
      provider,
      16384,
      Math.min(state.deadline, performance.now() + 10000),
    )
  ).toString("utf8");
  const metadata: unknown = JSON.parse(text);
  assert.ok(
    isRecord(metadata) &&
      metadata.id === acknowledgement.artifact_id &&
      metadata.name === name &&
      metadata.expired === false &&
      metadata.digest === "sha256:" + String(acknowledgement.sha256) &&
      isRecord(metadata.workflow_run) &&
      String(metadata.workflow_run.id) === state.inputs.run_id &&
      metadata.workflow_run.head_sha === state.inputs.source,
  );
  await recheck(state);
  return {
    stage: stage.kind,
    invocation: stage.invocation,
    artifact_id: acknowledgement.artifact_id,
    artifact_sha256: acknowledgement.sha256,
    name,
    public_files: files.map((row) => ({ ...row, path: path.basename(row.path) })),
    scope: "provider metadata correlation only; external bounded ZIP/member readback required",
    authority: "none",
  };
}
async function recover(state: State) {
  assert.ok(!state.recoveryAttempted, "One original diagnostic recovery only");
  state.recoveryAttempted = true;
  state.stopped = true;
  state.signal.emit("SIGTERM");
  await state.running;
  const owner = readProcessIdentity(state.owner.pid);
  assert.notEqual(
    owner && windowsOwnerFiletime(owner, state.owner.pid),
    state.owner.created,
    "Original owner is still live; no competing recovery",
  );
  assert.ok(
    state.account && performance.now() < state.deadline,
    "Original account ownership or cleanup budget unavailable",
  );
  const directory = path.join(state.root, "recovery");
  await mkdir(directory, { mode: 0o700 });
  let observed = state.stage?.station ?? null;
  if (state.stage && !observed) {
    try {
      observed = {
        before: await readControllerToolFile(
          path.join(state.stage.directory, "station-dacl-before.bin"),
          16384,
        ),
        proposed: await readControllerToolFile(
          path.join(state.stage.directory, "station-dacl-proposed.bin"),
          16384,
        ),
      };
    } catch {
      await retain(path.join(directory, "station-unknown.json"), {
        scope: "Original station preimage/proposal unavailable; no complete restoration claim",
        authority: "none",
      });
    }
  }
  await writeFile(path.join(directory, "release-hosted-native-windows-setup.cs.txt"), state.setup, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(path.join(directory, "recovery.ps1"), state.recovery, {
    flag: "wx",
    mode: 0o600,
  });
  const context = path.join(directory, "recovery-context.json"),
    bytes = await retain(
      context,
      {
        binding: state.binding,
        account_sid: state.account.sid,
        description: state.account.description,
        broker_sid: state.owner.broker,
        original_owner_pid: state.owner.pid,
        original_owner_created_filetime: state.owner.created,
        setup_sha256: hash(state.setup),
        station: observed
          ? {
              before_base64: observed.before.toString("base64"),
              proposed_base64: observed.proposed.toString("base64"),
            }
          : null,
        source_commit: state.inputs.source,
        run_id: state.inputs.run_id,
        run_attempt: 1,
      },
      65536,
    );
  recheckWindowsSourceSystemCustody(state.system);
  execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(directory, "recovery.ps1"),
      "-Context",
      context,
      "-ExpectedSha256",
      hash(bytes),
      "-Diagnostic",
    ],
    {
      cwd: directory,
      env: environment(state.root),
      timeout: Math.max(1, Math.min(30000, Math.floor(state.deadline - performance.now()))),
      maxBuffer: 16384,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result: unknown = JSON.parse(
    (await readControllerToolFile(path.join(directory, "recovery-result.json"), 16384)).toString(
      "utf8",
    ),
  );
  assert.ok(
    isRecord(result) &&
      result.binding === state.binding &&
      result.account_sid === state.account.sid &&
      result.disabled === true,
  );
  await account(state, false);
  if (observed) {
    assert.equal(result.station_restored, true);
    await station(state, observed.before);
  }
  return {
    account_disabled: true,
    station_restored: observed ? true : "Unknown",
    scope: "Exact original generation recovery only; no native acceptance",
    authority: "none",
  };
}
/** Fixed public projection only. Raw failure text/streams can contain private
 * values and are never uploaded. Hashes preserve their retained byte identities. */
export function projectHostedWindowsDiagnosticSettlementRecord(name: string, value: unknown) {
  assert.ok(isRecord(value));
  const out: Record<string, unknown> = {};
  const boolean = (key: string) => {
    if (typeof value[key] === "boolean") out[key] = value[key];
  };
  const integer = (key: string) => {
    if (
      Number.isSafeInteger(value[key]) &&
      Number(value[key]) >= -2147483648 &&
      Number(value[key]) <= 2147483647
    )
      out[key] = value[key];
  };
  for (const key of ["pid", "owner_pid", "exit_code", "harness_exit_code", "status"]) integer(key);
  for (const key of ["created_filetime", "owner_created_filetime"])
    if (typeof value[key] === "string" && /^[1-9][0-9]{0,18}$/u.test(value[key]))
      out[key] = value[key];
  for (const key of ["account_sid", "sid"])
    if (typeof value[key] === "string" && /^S-1-5-21-[0-9-]{1,128}$/u.test(value[key]))
      out[key] = value[key];
  if (name === "owner-final.json") {
    boolean("credential_disposed");
    out.failure_present = typeof value.failure === "string" ? value.failure.length > 0 : "Unknown";
    out.cleanup_failure_count =
      Array.isArray(value.cleanup_failures) && value.cleanup_failures.length <= 128
        ? value.cleanup_failures.length
        : "Unknown";
  } else if (name === "recovery/recovery-result.json" || name.endsWith("-settled.json")) {
    for (const key of ["disabled", "station_restored", "group_empty", "harness_drained"])
      boolean(key);
    out.station_restored ??= "Unknown";
    if (
      Array.isArray(value.broker_job_remaining_pids) &&
      value.broker_job_remaining_pids.length <= 128 &&
      value.broker_job_remaining_pids.every(
        (pid) => Number.isSafeInteger(pid) && Number(pid) > 0 && Number(pid) <= 2147483647,
      )
    )
      out.broker_job_remaining_pids = value.broker_job_remaining_pids;
  } else if (name.endsWith("/worker-failure.json")) {
    boolean("exited");
    out.reason = [
      "pipe-fault",
      "deadline",
      "unobserved-eof",
      "nonzero",
      "early-zero",
      "observer-error",
    ].includes(String(value.reason))
      ? value.reason
      : "Unknown";
  } else if (name.endsWith("/installer.json")) {
    out.complete = value.phase === "complete";
    out.failure_present = value.failure !== null;
    if (isRecord(value.details))
      for (const key of [
        "persistent_data_preserved",
        "managed_files_removed",
        "registration_removed",
      ])
        if (typeof value.details[key] === "boolean") out[key] = value.details[key];
  }
  return out;
}
export async function collectHostedWindowsDiagnosticPublicSettlement(
  root: string,
  deadline: number,
) {
  const names = [
    "owner-final.json",
    "recovery/recovery-result.json",
    "owner.stdout.bin",
    "owner.stderr.bin",
    ...(["payload-signing", "release-publication"] as const).flatMap((kind) => [
      kind + "-worker.json",
      kind + "-settled.json",
      ...[
        "worker-ready.json",
        "worker-result.json",
        "worker-failure.json",
        "worker-failure.stdout.bin",
        "worker-failure.stderr.bin",
        "harness.stdout.bin",
        "harness.stderr.bin",
        "installer.json",
      ].map((name) => kind + "/capture/" + name),
    ]),
  ];
  const records = [];
  for (const name of names) {
    try {
      const identity = await hashNativeCapturedFile(
        root,
        name,
        name.endsWith("/installer.json") ? 4 * 1024 ** 2 : 65536,
        deadline,
      );
      let selected: Record<string, unknown> | undefined;
      if (name.endsWith(".json")) {
        try {
          const bytes = await readControllerToolFile(
            path.join(root, name),
            name.endsWith("/installer.json") ? 4 * 1024 ** 2 : 65536,
          );
          assert.equal(hash(bytes), identity.sha256);
          selected = projectHostedWindowsDiagnosticSettlementRecord(
            name,
            JSON.parse(bytes.toString("utf8")) as unknown,
          );
        } catch {
          selected = { projection: "Unknown; malformed, changed or unavailable bounded record" };
        }
      }
      records.push({ ...identity, status: "retained", ...(selected ? { selected } : {}) });
    } catch (error) {
      records.push({
        path: name,
        status: errorCode(error) === "ENOENT" ? "missing" : "Unknown; bounded identity unavailable",
      });
    }
  }
  return records;
}
async function retainDiagnosticPublicSettlement(
  state: State,
  recovery: unknown,
  outcome: "succeeded" | "failed",
) {
  // Metadata-only finalization, not another owner/execution budget. No native
  // effect, recovery retry or deadline renewal is allowed here.
  const records = await collectHostedWindowsDiagnosticPublicSettlement(
    state.root,
    performance.now() + 5000,
  );
  await retain(
    path.join(diagnosticRoot, "diagnostic-public-settlement.json"),
    {
      schema_version: 1,
      source: state.inputs.source,
      tree: state.inputs.tree,
      run_id: state.inputs.run_id,
      attempt: 1,
      workflow: state.inputs.workflow,
      controller: {
        pid: process.pid,
        created_filetime: windowsOwnerFiletime(readProcessIdentity(process.pid), process.pid),
      },
      original_owner: { pid: state.owner.pid, created_filetime: state.owner.created },
      account_sid: state.account?.sid ?? null,
      outcome,
      original_owner_exited:
        state.owner.pid > 0 && readProcessIdentity(state.owner.pid) === null ? true : "Unknown",
      recovery,
      records,
      raw_private_streams_uploaded: false,
      authority: "none",
      production_acceptance: "not-established",
      automatic_retry: false,
      profile_erasure: "not-established; ephemeral runner teardown",
      scope: "Bounded selected original settlement/recovery facts and raw byte identities only",
    },
    65536,
  );
}

/** The source-false gate precedes provider, source, tool, account and station work. */
export async function runHostedWindowsConnectedDiagnostic() {
  held();
  const inputs = await readOriginalHostedWindowsDiagnosticInputs(),
    budget = await readOrdinaryHostedWindowsDiagnosticDeadline({
      source: inputs.source,
      run_id: inputs.run_id,
      attempt: "1",
    });
  await acknowledgeOriginalControllerStart(inputs, budget.deadline);
  const built = await freshTools(inputs, budget.deadline),
    root = path.join(diagnosticRoot, "owner"),
    binding = randomBytes(32).toString("hex"),
    nodeCreated = windowsOwnerFiletime(readProcessIdentity(process.pid), process.pid);
  const context = {
      schema_version: 1,
      binding,
      root,
      tools_root: built.tools,
      source_root: project,
      node_pid: process.pid,
      node_created_filetime: nodeCreated,
      run_id: inputs.run_id,
      run_attempt: 1,
      source_commit: inputs.source,
      source_tree: inputs.tree,
    },
    contextFile = path.join(root, "owner-context.json"),
    contextBytes = await retain(contextFile, context),
    readback = path.join(root, "original-station-readback.cs.txt");
  await writeFile(readback, built.setup, { flag: "wx", mode: 0o600 });
  const files = [
      contextFile,
      readback,
      path.join(built.tools, "manifest.json"),
      ...built.files.map((file) => path.join(built.tools, file.path)),
      ...inputs.evidence.map((file) => path.join(project, file.path)),
    ],
    signal = new EventEmitter();
  assert.equal(new Set(files).size, files.length);
  const state: State = {
    root,
    binding,
    deadline: budget.deadline,
    owner: { pid: 0, created: "", broker: "", bridge: "" },
    frequency: 0,
    clockSample: "",
    clockReceived: 0,
    fullTicks: "",
    activeTicks: "",
    account: null,
    error: undefined,
    signal,
    tools: { root: built.tools, node: path.join(built.tools, "bin/node.exe") },
    inputs,
    status: undefined,
    running: Promise.resolve(-1),
    stopped: false,
    sequence: 1,
    files,
    custody: inspectNativeRuntimeCustody(files),
    system: inspectWindowsSourceSystemCustody(),
    setup: built.setup,
    recovery: await readControllerToolFile(
      path.join(built.tools, "scripts/release-hosted-native-windows-recovery.ps1"),
      131072,
    ),
    recoveryAttempted: false,
  };
  const abi: unknown = JSON.parse(
    execFileSync(
      state.tools.node,
      [path.join(project, "scripts/release-native-worker.mts"), "--hosted-windows-diagnostic-abi"],
      {
        cwd: project,
        env: environment(root),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 16384,
        windowsHide: true,
      },
    ),
  );
  assert.ok(
    isRecord(abi) &&
      abi.abi === hostedWindowsWorkerAbi &&
      abi.execution_authorized === true &&
      abi.authority === "none",
    "Fresh diagnostic B gate/ABI remains held",
  );
  const profile = built.support,
    source = await readControllerToolFile(path.join(built.tools, profile.source), 65536),
    binary = await readControllerToolFile(
      path.join(built.tools, profile.binary),
      profile.maximumBinaryBytes,
    ),
    metadata = inspectNativeRuntimeSupport(
      JSON.parse(
        (await readControllerToolFile(path.join(built.tools, profile.metadata), 65536)).toString(
          "utf8",
        ),
      ),
      source,
      binary,
      "windows-x86_64",
    ),
    support = preparedNativeSupportDependencies(
      {
        caller_root: project + path.sep,
        output_parent: root,
        source_file: path.join(built.tools, profile.source),
        source,
        binary,
        metadata,
      },
      () => {
        assert.ok(!state.stopped && performance.now() < state.deadline);
        recheckNativeRuntimeCustody(state.files, state.custody);
      },
      () => {
        state.stopped = true;
      },
      "windows-x86_64",
    );
  const output = [
    openSync(path.join(root, "owner.stdout.bin"), "wx", 0o600),
    openSync(path.join(root, "owner.stderr.bin"), "wx", 0o600),
  ];
  state.running = runResourceCommand(
    "analysis",
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(built.tools, "scripts/release-hosted-native-windows-diagnostic-owner.ps1"),
      "-ContextBase64",
      contextBytes.toString("base64"),
    ],
    {
      cwd: built.tools,
      environment: environment(root),
      queueDeadline: state.deadline,
      executionTimeoutMilliseconds: Math.max(1, Math.floor(state.deadline - performance.now())),
      output: { stdout: output[0]!, stderr: output[1]! },
      exclusive: ["native-windows-original-account-owner"],
      supervise: (args, options) =>
        runRustTests(args, {
          ...options,
          ...support,
          tempRoot: root,
          signalTarget: signal,
          spawn: captureWindowsOwnerSupervisor(state, output),
        }),
    },
  );
  void state.running
    .finally(() => {
      for (const descriptor of output) closeSync(descriptor);
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
    Math.max(1, Math.floor(state.deadline - performance.now())),
  );
  void state.running.finally(() => clearTimeout(timer)).catch(() => {});
  let publicOutcome: "succeeded" | "failed" = "failed";
  let recoveryObservation: unknown = {
    status: "not-requested",
    account_disabled: "Unknown",
    station_restored: "Unknown",
  };
  try {
    await establishWindowsOwnerAccount(state, {
      toolsRoot: built.tools,
      powershell: windowsSourceSystemExecutables.powershell,
      read: (name) => read(state, name),
      remember: (files) => remember(state, files),
      write: (name, value) => request(state, name, value),
      inspectLineage: (...args) => lineage(state, ...args),
      inspectAccount: (enabled) => account(state, enabled),
      recheck: () => recheck(state),
    });
    const artifacts = [];
    for (const kind of ["payload-signing", "release-publication"] as const) {
      const stage = await prepareStage(state, kind);
      state.stage = stage;
      await startWindowsOwnerStageMechanism(state, stage, stageOptions(state, stage));
      await settleWindowsOwnerStageMechanism(state, stage, stageOptions(state, stage));
      artifacts.push(await diagnosticPublicCapture(state, stage));
    }
    await recheck(state);
    request(state, "owner-finish.json", {});
    assert.equal(await state.running, 0);
    const final: unknown = JSON.parse(
      (await readControllerToolFile(path.join(root, "owner-final.json"), 16384)).toString("utf8"),
    );
    assert.ok(
      isRecord(final) &&
        final.binding === binding &&
        final.owner_pid === state.owner.pid &&
        final.owner_created_filetime === state.owner.created &&
        final.failure === "" &&
        Array.isArray(final.cleanup_failures) &&
        final.cleanup_failures.length === 0 &&
        final.credential_disposed === true,
    );
    assert.equal(
      readProcessIdentity(state.owner.pid),
      null,
      "Original diagnostic owner exit unobserved",
    );
    await account(state, false);
    assert.ok(state.stage?.station);
    await station(state, state.stage.station.before);
    recheckNativeRuntimeCustody(state.files, state.custody);
    recheckNativeRuntimeCustody(inputs.drivers.files, inputs.drivers.custody);
    const result = {
      schema_version: 1,
      source: inputs.source,
      tree: inputs.tree,
      run_id: inputs.run_id,
      attempt: 1,
      workflow: inputs.workflow,
      controller: { pid: process.pid, created_filetime: nodeCreated },
      original_owner: state.owner,
      account_sid: state.account?.sid,
      artifacts,
      cleanup: {
        account_disabled: true,
        station_restored: true,
        credential_disposed: true,
        group_empty: true,
        original_owner_exited: true,
        profile_erasure: "not-established; retained for ephemeral runner teardown",
        private_roots: "retained bounded diagnostic evidence",
      },
      scope:
        "Nonproduction connected private-session real candidate observations only; external artifact ZIP readback required",
      production_acceptance: "not-established",
      authority: "none",
    };
    await retain(path.join(diagnosticRoot, "diagnostic-result.json"), result, 65536);
    state.stopped = true;
    publicOutcome = "succeeded";
    return result;
  } catch (error) {
    await retain(path.join(diagnosticRoot, "diagnostic-failure.json"), {
      source: inputs.source,
      run_id: inputs.run_id,
      attempt: 1,
      binding,
      failure:
        error instanceof Error ? error.message.slice(0, 1024) : "Original diagnostic refused",
      authority: "none",
      automatic_retry: false,
    }).catch(() => {});
    try {
      recoveryObservation = { status: "verified", ...(await recover(state)) };
    } catch (recovery) {
      recoveryObservation = {
        status: "Unknown; original recovery refused or unavailable",
        account_disabled: "Unknown",
        station_restored: "Unknown",
        automatic_retry: false,
      };
      await retain(path.join(diagnosticRoot, "recovery-unavailable.json"), {
        scope: "Exact original recovery remains Unknown; no competing owner or automatic retry",
        failure: recovery instanceof Error ? recovery.message.slice(0, 1024) : "Recovery refused",
        authority: "none",
      }).catch(() => {});
    }
    throw error;
  } finally {
    // Do not replace the original native/recovery failure if retention fails.
    await retainDiagnosticPublicSettlement(state, recoveryObservation, publicOutcome).catch(
      () => {},
    );
  }
}
function controlRoot() {
  const temporary = process.env.RUNNER_TEMP;
  assert.ok(temporary && path.isAbsolute(temporary));
  return path.join(temporary, "portcove-hosted-windows-connected-diagnostic");
}
async function acknowledgeOriginalControllerStart(inputs: Inputs, deadline: number) {
  const file = path.join(controlRoot(), "controller-ready.json"),
    value = {
      schema_version: 1,
      pid: process.pid,
      created_filetime: windowsOwnerFiletime(readProcessIdentity(process.pid), process.pid),
      source: inputs.source,
      tree: inputs.tree,
      run_id: inputs.run_id,
      attempt: 1,
      workflow: inputs.workflow,
      deadline_ns: String(
        process.hrtime.bigint() + BigInt(Math.floor((deadline - performance.now()) * 1e6)),
      ),
      phase:
        "inputs-verified; private account/station effects await original startup acknowledgement",
      authority: "none",
    },
    bytes = await retain(file, value);
  const until = Math.min(deadline, performance.now() + 30000);
  for (;;) {
    assert.ok(performance.now() < until, "Original controller start acknowledgement exhausted");
    try {
      const ack: unknown = JSON.parse(
        (
          await readControllerToolFile(path.join(controlRoot(), "controller-start-ack.json"), 4096)
        ).toString("utf8"),
      );
      assert.ok(
        isRecord(ack) &&
          Object.keys(ack).sort().join(",") ===
            "created_filetime,pid,ready_sha256,schema_version" &&
          ack.schema_version === 1 &&
          ack.pid === process.pid &&
          ack.created_filetime === value.created_filetime &&
          ack.ready_sha256 === hash(bytes),
      );
      assert.equal(
        windowsOwnerFiletime(readProcessIdentity(process.pid), process.pid),
        value.created_filetime,
      );
      return;
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EACCES"].includes(errorCode(error) ?? "")) throw error;
    }
    await delay(50);
  }
}
async function originalController() {
  held();
  const record: unknown = JSON.parse(
    (
      await readControllerToolFile(path.join(controlRoot(), "controller-ready.json"), 16384)
    ).toString("utf8"),
  );
  assert.ok(
    isRecord(record) &&
      record.schema_version === 1 &&
      Number.isSafeInteger(record.pid) &&
      Number(record.pid) > 0 &&
      typeof record.created_filetime === "string" &&
      typeof record.deadline_ns === "string" &&
      /^[1-9][0-9]{0,19}$/u.test(record.deadline_ns) &&
      record.source === process.env.GITHUB_SHA &&
      record.run_id === process.env.GITHUB_RUN_ID &&
      record.attempt === 1 &&
      record.workflow === process.env.GITHUB_WORKFLOW_REF &&
      record.authority === "none",
  );
  const deadline = BigInt(record.deadline_ns);
  assert.ok(process.hrtime.bigint() < deadline);
  return { pid: Number(record.pid), created: record.created_filetime, deadline };
}
async function transportFailure() {
  try {
    await lstat(path.join(controlRoot(), "controller-failure.json"));
    throw new Error(
      "Original diagnostic controller failed; retain its partial source/recovery evidence",
    );
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}
function stageRoot(kind: Kind) {
  return path.join(diagnosticRoot, "owner", kind, "public");
}
async function main() {
  held();
  const operation = process.argv[2];
  if (operation === "run" && process.argv.length === 3)
    return runHostedWindowsConnectedDiagnostic();
  const original = await originalController();
  if (operation === "abort" && process.argv.length === 3) {
    await retain(path.join(controlRoot(), "abort-request.json"), {
      pid: original.pid,
      created_filetime: original.created,
      source: process.env.GITHUB_SHA,
      run_id: process.env.GITHUB_RUN_ID,
      authority: "none",
    });
    return { original_abort_requested: true, authority: "none" };
  }
  const live = () => {
    assert.ok(
      process.hrtime.bigint() < original.deadline,
      "Original controller deadline exhausted",
    );
    assert.equal(
      windowsOwnerFiletime(readProcessIdentity(original.pid), original.pid),
      original.created,
      "Original controller generation stopped; no adoption",
    );
  };
  if (operation === "request" && process.argv.length === 4) {
    const kind = process.argv[3];
    assert.ok(kind === "payload-signing" || kind === "release-publication");
    for (;;) {
      await transportFailure();
      live();
      try {
        return await readHostedWindowsDiagnosticUploadRequest(stageRoot(kind), kind);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await delay(100);
    }
  }
  if (operation === "ack" && process.argv.length === 7) {
    const kind = process.argv[3];
    assert.ok(kind === "payload-signing" || kind === "release-publication");
    assert.match(process.argv[5] ?? "", /^[1-9][0-9]{0,15}$/u);
    live();
    await acknowledgeHostedWindowsDiagnosticUpload(
      stageRoot(kind),
      kind,
      process.argv[4]!,
      Number(process.argv[5]),
      process.argv[6]!,
    );
    live();
    return { acknowledgement_retained: true, authority: "none" };
  }
  if (operation === "settle" && process.argv.length === 3) {
    for (;;) {
      await transportFailure();
      let result: unknown;
      try {
        result = JSON.parse(
          (
            await readControllerToolFile(path.join(diagnosticRoot, "diagnostic-result.json"), 65536)
          ).toString("utf8"),
        ) as unknown;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        live();
        await delay(100);
        continue;
      }
      assert.ok(
        isRecord(result) &&
          result.source === process.env.GITHUB_SHA &&
          result.run_id === process.env.GITHUB_RUN_ID &&
          result.attempt === 1 &&
          isRecord(result.controller) &&
          result.controller.pid === original.pid &&
          result.controller.created_filetime === original.created &&
          result.authority === "none" &&
          result.production_acceptance === "not-established",
      );
      const identity = readProcessIdentity(original.pid);
      if (identity === null) return result;
      assert.equal(
        windowsOwnerFiletime(identity, original.pid),
        original.created,
        "Original controller generation differs; no adoption",
      );
      assert.ok(
        process.hrtime.bigint() < original.deadline,
        "Original controller exit unobserved inside its deadline",
      );
      await delay(100);
    }
  }
  throw new Error("Fixed connected diagnostic run/request/ack/settle operation required");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((result) => {
      if (process.argv[2] !== "run") console.log(JSON.stringify(result));
    })
    .catch(async (error: unknown) => {
      let originalContextVerified = false;
      try {
        requireOriginalHostedWindowsDiagnosticContext();
        originalContextVerified = true;
      } catch {
        /* Wrong scope cannot write even a failure record. */
      }
      if (hostedWindowsConnectedDiagnosticExecutionAuthorized && originalContextVerified) {
        await retain(path.join(controlRoot(), "controller-failure.json"), {
          source: process.env.GITHUB_SHA,
          run_id: process.env.GITHUB_RUN_ID,
          attempt: process.env.GITHUB_RUN_ATTEMPT,
          failure:
            error instanceof Error ? error.message.slice(0, 1024) : "Original controller refused",
          authority: "none",
          automatic_retry: false,
        }).catch(() => {});
      }
      if (process.argv[2] !== "run")
        console.error(
          "Connected diagnostic refused; retain original attempt and exact recovery evidence",
        );
      process.exitCode = 2;
    });
