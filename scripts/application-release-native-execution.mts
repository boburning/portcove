/** Fixed Windows native producer. Candidate images run only through the existing
 * separate-account owner mechanics; no signing/OIDC/publication input is used. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  applicationOutput,
  applicationFileIdentity,
  readApplicationJson,
  sha256,
  writeApplicationJson,
} from "./application-release-io.mts";
import {
  guardApplicationReleaseSource,
  readNativeApplicationSource,
  receiveNativePackages,
  preparePublicWindowsCandidate,
} from "./application-release-private.mts";
import {
  applicationNativeHarness,
  applicationNativeRequest,
  inspectApplicationNativeHost,
  inspectApplicationNativeAcceptance,
  inspectApplicationPublicInstalledJourney,
} from "./application-release-native.mts";
import type { ApplicationNativeBinding } from "./application-release-native.mts";
import { inspectApplicationReleaseExecution } from "./application-release-policy.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  inspectWindowsSourceSystemCustody,
  recheckWindowsSourceSystemCustody,
  readWindowsNativeProcessFiletime,
  windowsSourceSystemExecutables,
} from "./release-native-runtime-custody.mts";
import { inspectHostedNativeWindowsHost } from "./release-hosted-native-windows-host.mts";
import {
  hostedWindowsWorkerAbi,
  inspectHostedWindowsWorkerRequest,
} from "./release-hosted-native-windows-worker-contract.mts";
import { collectApplicationNativeReport } from "./release-native-pre-sign-report.mts";
import { serializeApplicationPreSignCapture } from "./release-native-stage-capture.mts";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import type { HistoricalJobProvider } from "./release-custody-provider.mts";
import { nativeCompatibilitySourcePaths } from "./release-native-source-contract.mts";
import { retainNativeSourceDeclarations } from "./release-native-source-provider.mts";
import { acquireWindowsWebviewDriver } from "./release-windows-webview-driver.mts";
import {
  controllerNativeDriverVersion,
  readControllerToolFile,
} from "./release-controller-tools.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { prepareRustSupportArtifact, rustSupportCompilerIdentity } from "./rust-support-cache.mts";
import { isRecord } from "./runtime-values.mts";
import {
  readOnlyReleaseChildEnvironment,
  withReadOnlyReleaseChildren,
} from "./release-readonly-child-environment.mts";
import {
  windowsOwnerEnvironment,
  writeWindowsOwnerFrame,
  captureWindowsOwnerSupervisor,
  readWindowsOwnerRecord,
  readWindowsOwnerWorkerRecord,
  copyWindowsOwnerStageFile,
  establishWindowsOwnerAccount,
  startWindowsOwnerStageMechanism,
  settleWindowsOwnerStageMechanism,
} from "./release-windows-owner-mechanism.mts";
import type { WindowsOwnerMechanismState } from "./release-windows-owner-mechanism.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixedScripts = [
  "application-release-native-owner.ps1",
  "release-hosted-native-windows-owner.ps1",
  "release-hosted-native-windows-owner-mechanism.ps1",
  "release-hosted-native-windows-diagnostic-owner.ps1",
  "release-hosted-native-windows-setup.cs.txt",
  "native-qualification-account.cs.txt",
  "native-qualification-account-bridge.ps1",
  "native-qualification-account-registry.ps1",
  "native-qualification-runtime-observation.psm1",
] as const;

export function inspectApplicationNativeExecutionEnvironment(environment: NodeJS.ProcessEnv) {
  const execution = inspectApplicationReleaseExecution(environment);
  assert.equal(environment.RUNNER_OS, "Windows");
  assert.equal(environment.RUNNER_ARCH, "X64");
  assert.equal(environment.RUNNER_ENVIRONMENT, "github-hosted");
  assert.ok(environment.GITHUB_JOB === "execute" || environment.GITHUB_JOB === "public_installed");
  assert.ok(
    !environment.PORTCOVE_SIGNING_KEY &&
      !environment.PORTCOVE_OBSERVER_TOKEN &&
      !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  );
  return execution;
}

export async function readPublicInstalledOwnerDeadline(
  current: ReturnType<typeof inspectApplicationReleaseExecution>,
  provider: Pick<HistoricalJobProvider, "jobs">,
) {
  const { body: raw, next } = await provider.jobs(current.run_id, current.run_attempt, 1);
  assert.equal(next, null, "original public installed job inventory is incomplete");
  assert.ok(isRecord(raw) && Array.isArray(raw.jobs) && raw.jobs.length < 100);
  assert.equal(raw.total_count, raw.jobs.length);
  const matches = raw.jobs.filter(
    (job: unknown) => isRecord(job) && job.name === "public_installed",
  );
  assert.equal(matches.length, 1);
  const job: unknown = matches[0];
  assert.ok(isRecord(job) && job.status === "in_progress" && typeof job.started_at === "string");
  assert.equal(job.run_id, Number(current.run_id));
  assert.equal(job.run_attempt, current.run_attempt);
  assert.equal(job.head_sha, current.source);
  const started = Date.parse(job.started_at);
  const now = Date.now();
  assert.ok(Number.isFinite(started) && started <= now);
  return performance.now() + started + 15 * 60_000 - now - 60_000;
}

async function produce() {
  assert.ok(process.platform === "win32" && process.arch === "x64");
  const current = inspectApplicationNativeExecutionEnvironment(process.env);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 15000 }).trim(),
    current.source,
  );
  const source = await readNativeApplicationSource();
  const publicJob = process.env.GITHUB_JOB === "public_installed";
  const token = readOnlyReleaseChildEnvironment()?.GH_TOKEN;
  assert.ok(token, "explicit native execution job reader required");
  const metadata = (deadline: number) =>
    createReleaseCustodyProvider({
      token,
      deadline,
      requestTimeoutMs: 30000,
      maxBytes: 8 * 1024 ** 2,
    });
  const publicDeadline = publicJob
    ? await readPublicInstalledOwnerDeadline(current, await metadata(performance.now() + 30000))
    : Infinity;
  const acquired = publicJob ? await preparePublicWindowsCandidate(source) : undefined;
  const publicInput = acquired?.ordinaryInputs;
  if (publicJob) assert.ok(publicInput && acquired?.candidate.predecessor);
  const packages = publicJob ? undefined : await receiveNativePackages(source);
  const stageKind = publicJob ? "ordinary-public-initial" : "payload-signing";
  await guardApplicationReleaseSource(source, false);
  const prepared = source.prepared;
  assert.ok(
    isRecord(prepared) &&
      typeof prepared.prepared_commit === "string" &&
      typeof prepared.prepared_tree === "string" &&
      typeof prepared.version === "string",
  );
  const minimum = process.env.PORTCOVE_APPLICATION_NATIVE_MINIMUM_PLATFORM;
  assert.ok(minimum === "windows-11-26h2-x64" || minimum === "windows-server-2022-x64-continuity");
  // Commit and config plus at most one Contents and immutable blob read per declaration.
  const provider = await metadata(
    Math.min(
      publicDeadline,
      performance.now() + (2 + 2 * nativeCompatibilitySourcePaths.length) * 30000,
    ),
  );
  const control = await provider.commit(current.source);
  assert.ok(
    isRecord(control) &&
      isRecord(control.tree) &&
      typeof control.tree.sha === "string" &&
      control.sha === current.source,
  );
  const configuration = await provider.file(
    "apps/desktop/src-tauri/tauri.conf.json",
    prepared.prepared_commit,
  );
  assert.ok(
    isRecord(configuration) &&
      configuration.encoding === "base64" &&
      typeof configuration.content === "string" &&
      configuration.content.length <= 128 * 1024,
  );
  const configBytes = Buffer.from(configuration.content, "base64");
  assert.ok(configBytes.length > 0 && configBytes.length <= 65536);
  const config: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(configBytes));
  assert.ok(
    isRecord(config) &&
      isRecord(config.bundle) &&
      isRecord(config.bundle.windows) &&
      typeof config.bundle.windows.minimumWebview2Version === "string",
  );
  const version = prepared.version;
  const preparedTree = prepared.prepared_tree;
  const controlTree = control.tree.sha;
  const minimumWebview = config.bundle.windows.minimumWebview2Version;
  const previous = acquired?.candidate.predecessor;
  const installer = previous
    ? {
        filename: `Portcove_${previous.version}_x64-setup.exe`,
        bytes: previous.installer_bytes,
        sha256: previous.installer_sha256,
      }
    : packages?.manifest.files.find(
        (file) => file.filename === `Portcove_${version}_x64-setup.exe`,
      );
  assert.ok(installer);
  const stem = publicJob ? "application-public-native" : "application-native";
  const output = path.join(root, "work", `${stem}-produced`);
  const tools = path.join(root, "work", `${stem}-tools`);
  const ownerRoot = path.join(root, "work", `${stem}-owner`);
  await mkdir(output);
  await mkdir(tools);
  await mkdir(path.join(tools, "scripts"));
  await mkdir(path.join(tools, "bin"));
  await mkdir(ownerRoot);
  const sourceCommit = prepared.prepared_commit;
  const declarations = publicJob
    ? undefined
    : await retainNativeSourceDeclarations(
        output,
        (pathname) => provider.file(pathname, sourceCommit),
        (blob) => provider.blob(blob),
      );
  for (const filename of fixedScripts)
    await copyFile(path.join(root, "scripts", filename), path.join(tools, "scripts", filename));
  await copyFile(process.execPath, path.join(tools, "bin/node.exe"));
  const closed = windowsOwnerEnvironment(ownerRoot);
  // Tool acquisition is fixed-source and finishes before the original native
  // owner clock starts. The enclosing33-minute job still bounds this work.
  const driverRoot = path.join(tools, "driver-build");
  const driverTimeout = Math.min(600000, Math.floor(publicDeadline - performance.now() - 150000));
  assert.ok(
    driverTimeout > 0,
    "hosted job cannot reserve time for the ordinary account and cleanup",
  );
  const built = spawnSync(
    "cargo",
    [
      "install",
      "tauri-driver",
      "--locked",
      "--version",
      `=${controllerNativeDriverVersion}`,
      "--profile",
      "dev",
      "--jobs",
      "2",
      "--no-track",
      "--root",
      driverRoot,
    ],
    {
      cwd: root,
      timeout: driverTimeout,
      stdio: "pipe",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
    },
  );
  assert.equal(built.status, 0, "fixed driver compilation failed; no native owner launched");
  await copyFile(
    path.join(driverRoot, "bin/tauri-driver.exe"),
    path.join(tools, "bin/tauri-driver.exe"),
  );
  await acquireWindowsWebviewDriver(root, tools, closed);
  const manifestFiles = await Promise.all(
    [
      ...fixedScripts.map((name) => `scripts/${name}`),
      "bin/node.exe",
      "bin/tauri-driver.exe",
      "bin/msedgedriver.exe",
    ].map(async (name) => ({
      path: name,
      ...(await applicationFileIdentity(path.join(tools, name))),
    })),
  );
  // The owner consumes only fixed path/size/hash fields. No old controller
  // configuration, compiler bundles, App tokens or storage writer is restored.
  await writeApplicationJson(path.join(tools, "manifest.json"), { files: manifestFiles });
  await guardApplicationReleaseSource(source, false);
  const system = inspectWindowsSourceSystemCustody();
  let status: number | undefined;
  const ownerDeadline = Math.min(performance.now() + 570000, publicDeadline);
  assert.ok(
    ownerDeadline - performance.now() >= 120000,
    "hosted job has insufficient time for account teardown",
  );
  const state: WindowsOwnerMechanismState & { tools: { node: string } } = {
    root: ownerRoot,
    binding: randomBytes(32).toString("hex"),
    deadline: ownerDeadline,
    owner: { pid: 0, created: "", broker: "", bridge: "" },
    frequency: 0,
    clockSample: "",
    clockReceived: 0,
    fullTicks: "",
    activeTicks: "",
    account: null,
    error: undefined,
    signal: new EventEmitter(),
    tools: { node: path.join(tools, "bin/node.exe") },
  };
  const ownerEnvironment = {
    ...closed,
    GITHUB_SHA: current.source,
    GITHUB_EVENT_NAME: "workflow_dispatch",
  };
  const files: string[] = [];
  let custody = inspectNativeRuntimeCustody(files);
  const active = () => {
    assert.ok(
      status === undefined && state.error === undefined && performance.now() < state.deadline,
      "original native owner stopped or clock exhausted",
    );
    recheckWindowsSourceSystemCustody(system);
    recheckNativeRuntimeCustody(files, custody);
  };
  const remember = async (incoming: string[]) => {
    active();
    files.push(...incoming);
    custody = inspectNativeRuntimeCustody(files);
  };
  const recheck = async () => {
    active();
  };
  const observe = (script: string) => {
    active();
    const value = execFileSync(
      windowsSourceSystemExecutables.powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from("$ErrorActionPreference='Stop';" + script, "utf16le").toString("base64"),
      ],
      {
        cwd: ownerRoot,
        env: ownerEnvironment,
        timeout: Math.max(1, Math.min(15000, Math.floor(state.deadline - performance.now()))),
        maxBuffer: 32768,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    active();
    return value.trim();
  };
  const read = (name: string) =>
    readWindowsOwnerRecord({ root: ownerRoot, binding: state.binding, active }, name);
  let sequence = 1;
  const frame = (file: string, value: Record<string, unknown>) => {
    active();
    writeWindowsOwnerFrame(file, value, {
      root: ownerRoot,
      deadline: state.deadline,
      powershell: windowsSourceSystemExecutables.powershell,
      environment: ownerEnvironment,
    });
    active();
  };
  const write = (name: string, value: Record<string, unknown>) =>
    frame(path.join(ownerRoot, name), {
      ...value,
      binding: state.binding,
      owner_pid: state.owner.pid,
      owner_created_filetime: state.owner.created,
      sequence: sequence++,
    });
  const inspectAccount = async (enabled: boolean) => {
    assert.ok(state.account);
    const account = state.account;
    const input = Buffer.from(JSON.stringify({ ...account, enabled })).toString("base64");
    const result: unknown = JSON.parse(
      observe(
        `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json;$u=Get-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($v.sid));if($u.Name -cne 'PortcoveNativeQual' -or $u.Description -cne $v.description -or $u.Enabled -ne $v.enabled){throw 'Original account identity/state differs'};@{sid=$u.SID.Value;enabled=$u.Enabled;broker_sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}|ConvertTo-Json -Compress`,
      ),
    );
    assert.ok(
      isRecord(result) &&
        result.sid === account.sid &&
        result.enabled === enabled &&
        result.broker_sid === state.owner.broker,
    );
  };
  const inspectLineage = async (pid: number, created: string, parent: number, image: string) => {
    assert.ok(
      Number.isSafeInteger(pid) &&
        pid > 0 &&
        pid <= 2147483647 &&
        Number.isSafeInteger(parent) &&
        parent > 0,
    );
    assert.equal(readWindowsNativeProcessFiletime(pid, state.deadline), created);
    const result: unknown = JSON.parse(
      observe(
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -Property ProcessId,ParentProcessId,ExecutablePath -OperationTimeoutSec 5;if(-not $p){throw 'Original child unavailable'};@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;image=$p.ExecutablePath}|ConvertTo-Json -Compress`,
      ),
    );
    assert.ok(
      isRecord(result) &&
        result.pid === pid &&
        result.parent === parent &&
        typeof result.image === "string" &&
        result.image.toLowerCase() === image.toLowerCase(),
    );
    assert.equal(readWindowsNativeProcessFiletime(pid, state.deadline), created);
  };
  const context = {
    schema_version: 1,
    binding: state.binding,
    root: ownerRoot,
    tools_root: tools,
    source_root: root.replace(/[\\/]$/u, ""),
    node_pid: process.pid,
    node_created_filetime: readWindowsNativeProcessFiletime(process.pid, state.deadline),
    run_id: current.run_id,
    run_attempt: current.run_attempt,
    source_commit: current.source,
    source_tree: controlTree,
  };
  const contextBytes = Buffer.from(JSON.stringify(context));
  assert.ok(process.env.GITHUB_OUTPUT && path.isAbsolute(process.env.GITHUB_OUTPUT));
  const jobOutput = process.env.GITHUB_OUTPUT;
  const originalOutput = await readFile(jobOutput);
  assert.equal(originalOutput.length, 0, "native producer requires its fresh step output file");
  // Reuse the maintained driver custody assertion rather than inventing another
  // ACL policy. Only its fixed function definition is loaded, never the driver.
  const custodyInput = Buffer.from(
    JSON.stringify({
      driver: path.join(root, "scripts/release-native-windows-driver.ps1"),
      paths: [context.source_root, tools, ownerRoot, jobOutput],
    }),
  ).toString("base64");
  observe(
    `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${custodyInput}'))|ConvertFrom-Json;$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($v.driver,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Fixed custody source does not parse'};$f=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-DriverOwnerPath'},$false));if($f.Count -ne 1){throw 'Fixed custody function missing'};. ([scriptblock]::Create($f[0].Extent.Text));foreach($p in $v.paths){Assert-DriverOwnerPath $p};'{}'`,
  );
  await writeFile(path.join(ownerRoot, "owner-context.json"), contextBytes, { flag: "wx" });
  await remember([
    path.join(ownerRoot, "owner-context.json"),
    ...manifestFiles.map((f) => path.join(tools, f.path)),
    path.join(tools, "manifest.json"),
  ]);
  const fds = ["owner.stdout.bin", "owner.stderr.bin"].map((name) =>
    openSync(path.join(ownerRoot, name), "wx", 0o600),
  );
  const running = runResourceCommand(
    "analysis",
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(tools, "scripts/application-release-native-owner.ps1"),
      "-ContextBase64",
      contextBytes.toString("base64"),
    ],
    {
      cwd: tools,
      environment: ownerEnvironment,
      queueDeadline: state.deadline,
      executionTimeoutMilliseconds: Math.max(1, Math.floor(state.deadline - performance.now())),
      output: { stdout: fds[0]!, stderr: fds[1]! },
      exclusive: ["native-windows-original-account-owner"],
      supervise: (args, options) =>
        runRustTests(args, {
          ...options,
          tempRoot: ownerRoot,
          signalTarget: state.signal,
          // Compile only the maintained fixed supervisor before entering the closed
          // owner environment. The candidate never receives compiler/token inputs.
          rustSupportCompilerIdentity: (settings) =>
            rustSupportCompilerIdentity({
              ...settings,
              environment: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
            }),
          prepareSupportArtifact: (settings) =>
            prepareRustSupportArtifact({
              ...settings,
              environment: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
            }),
          spawn: captureWindowsOwnerSupervisor(state, fds),
        }),
    },
  );
  void running
    .then(
      (value) => {
        status = value;
      },
      (error: unknown) => {
        state.error = error;
      },
    )
    .finally(() => {
      for (const fd of fds) closeSync(fd);
    });
  try {
    await establishWindowsOwnerAccount(state, {
      toolsRoot: tools,
      powershell: windowsSourceSystemExecutables.powershell,
      read,
      remember,
      write,
      inspectLineage,
      inspectAccount,
      recheck,
    });
    const startedAt = new Date().toISOString();
    const rawHost: unknown = JSON.parse(
      observe(
        `$o=Get-CimInstance Win32_OperatingSystem -Property Caption,Version,BuildNumber,ProductType -OperationTimeoutSec 5;$v=Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -Name DisplayVersion;$m=[string](Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid);if($m -cnotmatch '^[a-fA-F0-9-]{32,36}$'){throw 'Machine identity unavailable'};$h=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($m.ToLowerInvariant()))).ToLowerInvariant();@{schema_version=1;nonce='${state.binding}';architecture='x86_64';broker_sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;machine_id_sha256=$h;os=@{caption=$o.Caption;version=$o.Version;build_number=$o.BuildNumber;product_type=[int]$o.ProductType;display_version=$v}}|ConvertTo-Json -Depth 5 -Compress`,
      ),
    );
    const measured = inspectHostedNativeWindowsHost(rawHost, state.binding, minimum, "10.0.26200");
    assert.equal(measured.broker_sid, state.owner.broker);
    write(`${stageKind}-prepare.json`, { active_deadline_ticks: state.activeTicks });
    const paths = await read(`${stageKind}-prepared.json`);
    const stageRoot = path.join(ownerRoot, stageKind),
      directory = path.join(stageRoot, "capture"),
      readonly = path.join(stageRoot, "readonly"),
      work = path.join(stageRoot, "work");
    assert.equal(paths.value.stage, stageKind);
    assert.equal(paths.value.capture_root, directory);
    assert.equal(paths.value.readonly_root, readonly);
    assert.equal(paths.value.work_root, work);
    assert.ok(state.account);
    const copy = async (from: string, to: string, maximum = 128 * 1024 ** 2) => {
      const identity = await applicationFileIdentity(from);
      const dest = await copyWindowsOwnerStageFile({ active }, from, to, maximum, identity.sha256);
      await remember([dest]);
      return { path: dest, sha256: identity.sha256 };
    };
    const tauri = await copy(
      path.join(tools, "bin/tauri-driver.exe"),
      path.join(readonly, "tauri-driver.exe"),
    );
    const edge = await copy(
      path.join(tools, "bin/msedgedriver.exe"),
      path.join(readonly, "msedgedriver.exe"),
    );
    const registry = await copy(
      path.join(tools, "scripts/native-qualification-account-registry.ps1"),
      path.join(readonly, "native-qualification-account-registry.ps1"),
      131072,
    );
    const installerCopy = await copy(
      previous && acquired
        ? path.join(acquired.directory, "predecessor", installer.filename)
        : path.join(root, "work/application-unsigned", installer.filename),
      path.join(readonly, publicJob ? "predecessor.exe" : "candidate.exe"),
      installer.bytes,
    );
    assert.equal(installerCopy.sha256, installer.sha256);
    const publicInputs =
      publicInput && acquired
        ? await copy(
            path.join(acquired.directory, "ordinary-public-inputs.json"),
            path.join(readonly, "public-inputs.json"),
            16384,
          )
        : undefined;
    const helperSha = sha256(
      await readFile(path.join(tools, "scripts/native-qualification-account.cs.txt")),
    );
    const bridgeConfiguration = {
      schema_version: 1,
      broker_sid: state.owner.broker,
      account_sid: state.account.sid,
      account_name: "PortcoveNativeQual",
      profile_root: state.account.profile,
      work_root: work,
      capture_root: directory,
      helper_sha256: helperSha,
      controller_root: state.owner.bridge,
    };
    const bridgeFile = path.join(directory, "bridge-configuration.json");
    await writeApplicationJson(bridgeFile, bridgeConfiguration);
    const invocation = randomBytes(32).toString("hex");
    const powershell = {
      path: windowsSourceSystemExecutables.powershell,
      sha256: sha256(
        await readControllerToolFile(windowsSourceSystemExecutables.powershell, 32 * 1024 ** 2),
      ),
    };
    const node = { path: state.tools.node, sha256: sha256(await readFile(state.tools.node)) };
    const binding = {
      invocation_id: invocation,
      configuration_sha256: sha256(await readFile(bridgeFile)),
      helper_sha256: helperSha,
      broker_pid: state.owner.pid,
      broker_created_filetime: state.owner.created,
      capture_root: directory,
      account_sid: state.account.sid,
      profile_root: state.account.profile,
      work_root: work,
      controller_root: state.owner.bridge,
      powershell,
      desktop_tools: { node, tauri_driver: tauri, webview_driver: edge },
      hosted: {
        profile: hostedWindowsWorkerAbi,
        harness_root: context.source_root,
        registry_sha256: registry.sha256,
      },
    };
    const bindingFile = path.join(directory, "account-binding.json");
    await writeApplicationJson(bindingFile, binding);
    const bindingSha = sha256(await readFile(bindingFile));
    assert.ok(isRecord(rawHost) && isRecord(rawHost.os));
    const host = inspectApplicationNativeHost(
      {
        machine_id_sha256: measured.machine_id_sha256,
        nonce: state.binding,
        account_binding_sha256: bindingSha,
        qualification_profile: "fixed-hosted-native-v1",
        execution_context:
          minimum === "windows-11-26h2-x64"
            ? "native-windows-11-26h2-hosted-isolated-account"
            : "native-windows-server-2022-hosted-isolated-account",
        account: {
          kind: "windows-sid",
          broker: state.owner.broker,
          qualification: state.account.sid,
        },
        os: rawHost.os,
        qualification_is_administrator: false,
        qualification_is_elevated: false,
      },
      minimum,
    );
    const harnessSha = sha256(await readFile(applicationNativeHarness));
    const workerInput = inspectHostedWindowsWorkerRequest({
      schema_version: 1,
      abi: hostedWindowsWorkerAbi,
      stage: stageKind,
      binding: { path: bindingFile, sha256: bindingSha },
      capture_root: directory,
      work_root: work,
      package: {
        path: installerCopy.path,
        bytes: installer.bytes,
        sha256: installer.sha256,
        version: previous?.version ?? prepared.version,
      },
      predecessor: null,
      ...(publicInputs ? { public_inputs: publicInputs } : {}),
      tools: {
        node,
        powershell,
        git: {
          path: windowsSourceSystemExecutables.git,
          sha256: sha256(await readControllerToolFile(windowsSourceSystemExecutables.git)),
        },
      },
      worker_sha256: harnessSha,
      remaining_milliseconds: Math.floor(state.deadline - performance.now() - 30000),
    });
    const workerFile = path.join(directory, "worker-input.json");
    await writeApplicationJson(workerFile, workerInput);
    await remember([bridgeFile, bindingFile, workerFile]);
    const stage = {
      kind: stageKind,
      directory,
      binding,
      workerRequestSha: sha256(await readFile(workerFile)),
      bindingSha,
      station: null as { before: Buffer; proposed: Buffer } | null,
    } satisfies Parameters<typeof startWindowsOwnerStageMechanism>[1];
    const operations = {
      invocationId: invocation,
      active,
      recheck,
      recheckStage: active,
      write,
      read,
      workerRecord: (name: "worker-ready" | "worker-result") =>
        readWindowsOwnerWorkerRecord({ active }, directory, name),
      remember,
      inspectAccount,
      inspectLineage,
      frame,
    };
    await startWindowsOwnerStageMechanism(state, stage, operations);
    await settleWindowsOwnerStageMechanism(state, stage, {
      ...operations,
      station: async (before) => {
        const encoded = Buffer.from(
          path.join(tools, "scripts/release-hosted-native-windows-setup.cs.txt"),
        ).toString("base64");
        const actual = observe(
          `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));Add-Type -TypeDefinition ([IO.File]::ReadAllText($p));[Convert]::ToBase64String([Portcove.HostedNative.HostedDesktop]::ReadCurrentStation())`,
        );
        assert.ok(
          Buffer.from(actual, "base64").equals(before),
          "independent station restoration differs",
        );
      },
    });
    const evidence = await (async () => {
      if (publicJob) {
        assert.ok(publicInput && acquired && publicInputs);
        const installer = await readApplicationJson(
          path.join(directory, "installer.json"),
          4 * 1024 ** 2,
        );
        const journey = await readApplicationJson(
          path.join(directory, "ordinary-public-update/public-update-journey.json"),
          4 * 1024 ** 2,
        );
        inspectApplicationPublicInstalledJourney(installer, journey, {
          ...publicInput,
          invocation,
          harness_sha256: sha256(
            await readFile(
              path.join(root, "apps/desktop/scripts/desktop-windows-public-update.mts"),
            ),
          ),
        });
        return {
          kind: "public" as const,
          installer,
          journey,
          publicInputs,
          acquired,
          publicInput,
          settlement: (await read(`${stageKind}-settled.json`)).value,
        };
      }
      assert.ok(packages && declarations);
      const expected: ApplicationNativeBinding = {
        control_commit: current.source,
        control_tree: controlTree,
        control_ref: current.ref,
        harness_sha256: harnessSha,
        run_id: current.run_id,
        native_attempt: current.run_attempt,
        package_attempt: Number(process.env.PORTCOVE_PACKAGE_ATTEMPT),
        unsigned_artifact: Number(process.env.PORTCOVE_UNSIGNED_ARTIFACT),
        source_commit: sourceCommit,
        source_tree: preparedTree,
        package: installer,
        package_manifest_sha256: sha256(
          await readFile(path.join(root, "work/application-unsigned/application-release.json")),
        ),
        minimum_webview2_version: minimumWebview,
        minimum_platform: minimum,
        host,
        native_invocation_id: invocation,
        setup_plan_sha256: process.env.PORTCOVE_APPLICATION_SETUP_PLAN_SHA256 ?? "",
        source_declarations: declarations,
      };
      const request = applicationNativeRequest(expected);
      const nativeRequest = {
        request,
        request_sha256: digest(request),
        authority: "none" as const,
        scope: "integrity-only" as const,
      };
      const runtimeInput = Buffer.from(
        JSON.stringify({
          module: path.join(tools, "scripts/native-qualification-runtime-observation.psm1"),
          capture: directory,
          binding: bindingSha,
        }),
      ).toString("base64");
      const observation: unknown = JSON.parse(
        observe(
          `$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${runtimeInput}'))|ConvertFrom-Json;Import-Module $v.module -Force;Read-PortcoveNativeRuntimeObservation -CaptureRoot $v.capture -BindingSha256 $v.binding|ConvertTo-Json -Depth 8 -Compress`,
        ),
      );
      const driver = {
        schema_version: 1,
        invocation_id: invocation,
        request_sha256: nativeRequest.request_sha256,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        failure: null,
        finish_attempted: true,
        host_observation: observation,
        scope: "original hosted owner and independently settled B worker; data only",
        authority: "none",
        native_acceptance: "not-established",
      };
      await writeApplicationJson(path.join(directory, "driver-result.json"), driver);
      const report = await collectApplicationNativeReport({
        status: 0,
        result: driver,
        capture_directory: directory,
        directory: output,
        request: nativeRequest,
        version,
        predecessor: null,
        payload_cryptography: null,
        parent: { controller_root: context.source_root },
        hosted: { host: rawHost, nonce: state.binding },
        readSource: async () => ({ declaration: declarations }),
        serialize: (_raw, capture) =>
          serializeApplicationPreSignCapture(capture, {
            request_sha256: nativeRequest.request_sha256,
            harness: request.expected.producer.harness,
          }),
        recheck,
      });
      inspectApplicationNativeAcceptance(report.report, report.capture, report.evidence, expected);
      return { kind: "pre-sign" as const, report };
    })();
    write("owner-finish.json", {});
    assert.equal(await running, 0, "original owner exit not successful");
    const final = await readApplicationJson(path.join(ownerRoot, "owner-final.json"), 16384);
    assert.ok(
      isRecord(final) &&
        final.binding === state.binding &&
        final.owner_pid === state.owner.pid &&
        final.owner_created_filetime === state.owner.created &&
        final.failure === "" &&
        Array.isArray(final.cleanup_failures) &&
        final.cleanup_failures.length === 0 &&
        final.credential_disposed === true,
    );
    assert.notEqual(
      readWindowsNativeProcessFiletime(state.owner.pid, state.deadline),
      state.owner.created,
    );
    assert.ok(
      (await readFile(jobOutput)).equals(originalOutput),
      "native step output changed before trusted emission",
    );
    // After the original group and owner have settled, emit only fixed data.
    // A separate fresh job reconstructs it again before attestation.
    if (evidence.kind === "public") {
      await evidence.acquired.assertCurrentSite();
      await writeApplicationJson(path.join(output, "public-installed.json"), {
        schema_version: 1,
        authority: "none",
        kind: "application-public-installed-observation",
        control_commit: current.source,
        control_ref: current.ref,
        run_id: current.run_id,
        run_attempt: current.run_attempt,
        host,
        invocation,
        candidate: evidence.acquired.candidate,
        inputs: evidence.publicInput,
        inputs_sha256: evidence.publicInputs.sha256,
        installer_sha256: digest(evidence.installer),
        journey_sha256: digest(evidence.journey),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        stage_settlement: evidence.settlement,
        owner_teardown: final,
      });
      await writeApplicationJson(path.join(output, "installer.json"), evidence.installer);
      await writeApplicationJson(path.join(output, "public-update-journey.json"), evidence.journey);
    } else {
      await writeApplicationJson(
        path.join(output, "native-qualification.json"),
        evidence.report.report,
      );
      await writeApplicationJson(path.join(output, "native-capture.json"), evidence.report.capture);
      await writeApplicationJson(
        path.join(output, "native-evidence.json"),
        evidence.report.evidence,
      );
    }
    await applicationOutput("attempt", current.run_attempt);
    await applicationOutput("host", JSON.stringify(host));
    await applicationOutput("invocation", invocation);
  } catch (error) {
    state.signal.emit("SIGTERM");
    await running.catch(() => {});
    // Preserve all original partial evidence; never synthesize a report or
    // automatically start another owner after ambiguous cleanup.
    await writeApplicationJson(path.join(output, "producer-failure.json"), {
      authority: "none",
      run_id: current.run_id,
      attempt: current.run_attempt,
      owner: state.owner,
      account: state.account,
      error: error instanceof Error ? error.message.slice(0, 1024) : "native producer failed",
    });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.env.RUNNER_TEMP);
  const directory = path.join(
    process.env.RUNNER_TEMP,
    `application-native-reads-${randomBytes(8).toString("hex")}`,
  );
  await mkdir(directory);
  await withReadOnlyReleaseChildren(directory, produce);
}
