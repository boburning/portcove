/** Unbranded, credential-free preparation for the separately held diagnostic.
 * Captured bytes/observations are not protected production receipts. */
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { isBuiltin } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile, readdir, lstat } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { isRecord, errorCode } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  bundleWindowsSourcePreparation,
  controllerBootstrapEnvironment,
  materializeControllerNativeSupport,
} from "./release-controller-tool-build.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  inspectWindowsSourceSystemCustody,
  recheckWindowsSourceSystemCustody,
  windowsSourceSystemExecutables,
  windowsCustodyReaderSource,
} from "./release-native-runtime-custody.mts";
import {
  copyWindowsOwnerStageFile,
  windowsOwnerEnvironment,
} from "./release-windows-owner-mechanism.mts";
import {
  inspectWindowsNativeSourceTree,
  verifyWindowsNativeSourceFiles,
  hostedWindowsDependencyPreparationMilliseconds,
} from "./release-hosted-native-windows-source.mts";
import {
  inspectWindowsNativeDependencyInputs,
  snapshotWindowsNativeDependencies,
} from "./release-hosted-native-windows-dependency-files.mts";
import {
  nativeRuntimeSupportProfile,
  inspectNativeRuntimeSupport,
  preparedNativeSupportDependencies,
} from "./release-native-runtime-support.mts";
import {
  requireOriginalHostedWindowsDiagnosticContext,
  readOrdinaryHostedWindowsDiagnosticDeadline,
  hostedWindowsDiagnosticOwnerMilliseconds,
  hostedWindowsDiagnosticProviderMilliseconds,
  hostedWindowsDiagnosticPreparationRoot,
} from "./release-hosted-native-windows-diagnostic-source.mts";
import { acquireNativePnpm } from "./release-pnpm-runtime.mts";
import { nativeQualificationWorkerPath } from "./release-native-qualification-contract.mts";
import { inspectSupportedHostedWindowsRuntimeInput } from "./hosted-windows-runtime-input.mts";
import { toolCachePaths, cachedDesktopDrivers } from "./tool-cache.mts";
import { hashNativeCapturedFile } from "./release-native-capture-files.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import {
  prepareRustSupportArtifact,
  rustSupportCompilerIdentity,
  type CompilerRunner,
} from "./rust-support-cache.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const diagnosticPreparationMaximumMilliseconds = 480000;

/** One original provider reserve check, before queue/compiler/private effects. */
export function requireHostedWindowsDiagnosticPreparationReserve(remaining: number) {
  assert.ok(
    Number.isSafeInteger(remaining) &&
      remaining >= 0 &&
      remaining <= hostedWindowsDiagnosticProviderMilliseconds,
  );
  try {
    assert.ok(
      remaining >=
        diagnosticPreparationMaximumMilliseconds + hostedWindowsDiagnosticOwnerMilliseconds,
      "Original provider cannot preserve preparation and owner reserves",
    );
  } catch (error) {
    try {
      if (error instanceof Error)
        Object.defineProperty(error, "diagnostic_preparation_reserve", {
          value: Object.freeze({
            maximum_provider_milliseconds: hostedWindowsDiagnosticProviderMilliseconds,
            preparation_milliseconds: diagnosticPreparationMaximumMilliseconds,
            owner_milliseconds: hostedWindowsDiagnosticOwnerMilliseconds,
            provider_finalizer_milliseconds: 60000,
            observed_remaining_milliseconds: remaining,
            required_remaining_milliseconds:
              diagnosticPreparationMaximumMilliseconds + hostedWindowsDiagnosticOwnerMilliseconds,
          }),
        });
    } catch {
      /* Optional public metadata never replaces the original reserve refusal. */
    }
    throw error;
  }
}

/** Original ordinary resource supervisor owns preparation and all descendants.
 * Its one deadline includes admission/compiler setup, never private-owner time. */
export async function superviseHostedWindowsDiagnosticPreparation() {
  const context = requireOriginalHostedWindowsDiagnosticContext();
  const provider = await readOrdinaryHostedWindowsDiagnosticDeadline({ ...context, attempt: "1" });
  requireHostedWindowsDiagnosticPreparationReserve(
    Math.floor(provider.provider_remaining_deadline - performance.now()),
  );
  const until = performance.now() + diagnosticPreparationMaximumMilliseconds;
  const boundedSpawn: CompilerRunner = (command, args, options) => {
    const remaining = Math.floor(until - performance.now());
    assert.ok(remaining > 0, "Original ordinary preparation compiler window exhausted");
    const result = spawnSync(command, args, {
      ...options,
      timeout: Math.min(remaining, options.timeout ?? remaining),
    });
    if (
      errorCode(result.error) === "ETIMEDOUT" &&
      Number.isSafeInteger(result.pid) &&
      result.pid > 0
    )
      throw Object.assign(
        new Error("Original setup compiler timed out; descendant settlement Unknown", {
          cause: result.error,
        }),
        {
          code: "PORTCOVE_SUPPORT_SETUP_UNKNOWN",
          setup_pid: result.pid,
        },
      );
    return result;
  };
  const environment: NodeJS.ProcessEnv = { ...windowsOwnerEnvironment(project) };
  for (const name of [
    "GITHUB_SHA",
    "GITHUB_EVENT_NAME",
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "GITHUB_REPOSITORY",
    "GITHUB_JOB",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "PORTCOVE_HOSTED_PLATFORM",
    "PORTCOVE_HOSTED_OBSERVATION_ONLY",
    "PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC",
    "LOCALAPPDATA",
    "HOME",
    "USERPROFILE",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "RUNNER_TEMP",
    "RUNNER_TRACKING_ID",
    "PORTCOVE_SHARED_TOOL_CACHE",
    "RUSTUP_HOME",
    "CARGO_HOME",
  ])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  environment.PORTCOVE_DIAGNOSTIC_PREPARATION_DEADLINE_NS = String(
    process.hrtime.bigint() + BigInt(Math.floor((until - performance.now()) * 1e6)),
  );
  const status = await runResourceCommand(
    "analysis",
    process.execPath,
    [path.join(project, "scripts/release-hosted-native-windows-diagnostic.mts"), "prepare-payload"],
    {
      cwd: project,
      environment,
      queueDeadline: until,
      executionTimeoutMilliseconds: Math.max(1, Math.floor(until - performance.now())),
      executionDeadline: until,
      supervise: (args, dependencies) =>
        runRustTests(args, {
          ...dependencies,
          rustSupportCompilerIdentity: (options) =>
            rustSupportCompilerIdentity({ ...options, runSync: boundedSpawn }),
          prepareSupportArtifact: (options) =>
            prepareRustSupportArtifact({ ...options, runSync: boundedSpawn }),
        }),
    },
  );
  assert.equal(
    status,
    0,
    "Original supervised diagnostic preparation refused; retain partial state",
  );
  return { authority: "none", preparation_completed: true };
}

export async function prepareHostedWindowsDiagnosticClosure() {
  const context = requireOriginalHostedWindowsDiagnosticContext();
  const original = process.env.PORTCOVE_DIAGNOSTIC_PREPARATION_DEADLINE_NS;
  assert.ok(
    typeof original === "string" && /^[1-9][0-9]{0,24}$/u.test(original),
    "Original supervised preparation clock required",
  );
  const provider = await readOrdinaryHostedWindowsDiagnosticDeadline({ ...context, attempt: "1" });
  const originalRemaining = Number((BigInt(original) - process.hrtime.bigint()) / 1000000n);
  assert.ok(
    Number.isSafeInteger(originalRemaining) &&
      originalRemaining > 0 &&
      originalRemaining <= diagnosticPreparationMaximumMilliseconds,
  );
  assert.ok(
    provider.provider_remaining_deadline - performance.now() >=
      originalRemaining + hostedWindowsDiagnosticOwnerMilliseconds,
    "Original provider cannot retain remaining preparation and owner reserve",
  );
  const deadline = Math.min(
    performance.now() + originalRemaining,
    provider.provider_remaining_deadline - hostedWindowsDiagnosticOwnerMilliseconds,
  );
  const active = () => {
    requireOriginalHostedWindowsDiagnosticContext();
    assert.ok(performance.now() < deadline, "Original diagnostic preparation window exhausted");
    assert.ok(
      provider.provider_remaining_deadline - performance.now() >=
        hostedWindowsDiagnosticOwnerMilliseconds,
      "Original provider cannot retain the owner reserve",
    );
  };
  active();
  assert.equal(process.version, "v24.22.1");
  assert.equal(path.basename(process.execPath), "node.exe");
  await hashNativeCapturedFile(
    path.dirname(process.execPath),
    "node.exe",
    128 * 1024 ** 2,
    deadline,
  );
  const root = hostedWindowsDiagnosticPreparationRoot(os.homedir(), context.source, context.run_id),
    tools = path.join(root, "tools"),
    setupName = "scripts/release-hosted-native-windows-setup.cs.txt",
    setup = await readControllerToolFile(path.join(project, setupName), 131072),
    sourceSystem = inspectWindowsSourceSystemCustody();
  const git = (args: string[]) => {
    active();
    return execFileSync(windowsSourceSystemExecutables.git, ["-C", project, ...args], {
      timeout: Math.min(10000, Math.max(1, Math.floor(deadline - performance.now()))),
      maxBuffer: 65536,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  };
  assert.equal(git(["rev-parse", "HEAD"]), context.source);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  assert.match(tree, /^[a-f0-9]{40}$/u);
  git(["diff", "--quiet", "HEAD", "--"]);
  const creation = Buffer.from(JSON.stringify({ root, setup: setup.toString("base64") })).toString(
    "base64",
  );
  execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference='Stop';$v=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${creation}'))|ConvertFrom-Json;Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($v.setup)));[Portcove.HostedNative.Setup]::Directory($v.root,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'',$false)`,
        "utf16le",
      ).toString("base64"),
    ],
    {
      timeout: Math.min(15000, Math.max(1, Math.floor(deadline - performance.now()))),
      maxBuffer: 16384,
      env: windowsOwnerEnvironment(project),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  active();
  await mkdir(path.join(tools, "scripts"), { recursive: true });
  await mkdir(path.join(tools, "bin"));
  await mkdir(path.join(root, "home"));
  await mkdir(path.join(root, "temp"));
  await mkdir(path.join(root, "target"));
  const captured: { path: string; bytes: number; sha256: string }[] = [];
  const capture = async (from: string, to: string, maximum: number) => {
    active();
    const before = await readControllerToolFile(from, maximum);
    await mkdir(path.dirname(to), { recursive: true });
    await copyWindowsOwnerStageFile({ active }, from, to, maximum, digest(before));
    captured.push({ path: path.relative(root, to), bytes: before.length, sha256: digest(before) });
    active();
  };
  // These are same-job ordinary bootstrap outputs; no original C has started.
  await capture(process.execPath, path.join(tools, "bin/node.exe"), 128 * 1024 ** 2);
  await capture(path.join(project, setupName), path.join(tools, setupName), 131072);
  await bundleWindowsSourcePreparation(project, tools);
  active();
  const bundle = path.join(tools, "scripts/release-hosted-native-windows-source.bundle.mjs");
  assert.ok(
    deadline - performance.now() >= 30000,
    "Original preparation cannot retain the fixed pnpm acquisition budget",
  );
  const pnpm = await acquireNativePnpm("windows-x86_64");
  active();
  await writeFile(path.join(tools, "bin/pnpm.exe"), pnpm.binary, { flag: "wx", flush: true });
  const support = nativeRuntimeSupportProfile("windows-x86_64");
  await capture(path.join(project, support.source), path.join(tools, support.source), 65536);
  const environment = {
    ...controllerBootstrapEnvironment(path.join(root, "home"), path.join(root, "target")),
    PATH: path.join(tools, "bin") + ";C:\\Windows\\System32",
    GITHUB_ACTIONS: "true",
    RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID,
    RUNNER_TEMP: path.join(root, "temp"),
  };
  await materializeControllerNativeSupport(
    tools,
    tools,
    {
      ...controllerBootstrapEnvironment(path.join(root, "home"), path.join(root, "target")),
      RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID,
    },
    "windows-x86_64",
    deadline,
  );
  active();
  await writeFile(
    path.join(tools, "scripts/release-native-runtime-custody-reader.ps1"),
    windowsCustodyReaderSource(),
    { flag: "wx", flush: true },
  );
  const runtimeFiles = [
    path.join(tools, "bin/node.exe"),
    path.join(tools, "bin/pnpm.exe"),
    bundle,
    path.join(tools, setupName),
    path.join(tools, support.source),
    path.join(tools, support.binary),
    path.join(tools, support.metadata),
    path.join(tools, "scripts/release-native-runtime-custody-reader.ps1"),
  ];
  const custody = inspectNativeRuntimeCustody(runtimeFiles);
  let stopped = false;
  const recheck = () => {
    active();
    assert.equal(stopped, false);
    recheckNativeRuntimeCustody(runtimeFiles, custody);
    recheckWindowsSourceSystemCustody(sourceSystem);
  };
  const supportSource = await readControllerToolFile(path.join(tools, support.source), 65536),
    supportBinary = await readControllerToolFile(
      path.join(tools, support.binary),
      support.maximumBinaryBytes,
    ),
    supportMetadata = inspectNativeRuntimeSupport(
      JSON.parse(
        (await readControllerToolFile(path.join(tools, support.metadata), 65536)).toString("utf8"),
      ),
      supportSource,
      supportBinary,
      "windows-x86_64",
    ),
    prepared = preparedNativeSupportDependencies(
      {
        caller_root: project,
        output_parent: root,
        source_file: path.join(tools, support.source),
        source: supportSource,
        binary: supportBinary,
        metadata: supportMetadata,
      },
      recheck,
      () => {
        stopped = true;
      },
      "windows-x86_64",
    );
  const binding = digest(
    Buffer.from(
      JSON.stringify({
        source: context.source,
        tree,
        run: context.run_id,
        workflow: context.workflow,
      }),
    ),
  );
  const run = async (operation: "source" | "dependencies", plan: unknown, maximum: number) => {
    recheck();
    const operationDeadline = Math.min(deadline, performance.now() + maximum),
      planFile = path.join(root, `windows-${operation}-intent.json`);
    await writeFile(planFile, JSON.stringify(plan), { flag: "wx", flush: true });
    const inputCustody = inspectNativeRuntimeCustody([planFile]);
    const stdout = openSync(path.join(root, `windows-${operation}.json`), "wx"),
      stderr = openSync(path.join(root, `windows-${operation}.stderr.bin`), "wx");
    let exit;
    try {
      exit = await runResourceCommand(
        "analysis",
        runtimeFiles[0]!,
        [bundle, `acquire-${operation}`, planFile],
        {
          cwd: root,
          environment,
          output: { stdout, stderr },
          queueDeadline: operationDeadline,
          executionTimeoutMilliseconds: Math.max(
            1,
            Math.floor(operationDeadline - performance.now()),
          ),
          executionDeadline: operationDeadline,
          supervise: (args, dependencies) =>
            runRustTests(args, { ...dependencies, ...prepared, tempRoot: root }),
        },
      );
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    recheck();
    recheckNativeRuntimeCustody([planFile], inputCustody);
    assert.equal(
      exit,
      0,
      `Original diagnostic ${operation} preparation refused; retain private partial state`,
    );
    const result: unknown = JSON.parse(
      (await readControllerToolFile(path.join(root, `windows-${operation}.json`), 65536)).toString(
        "utf8",
      ),
    );
    assert.ok(
      isRecord(result) &&
        result.binding === binding &&
        result.authority === "none" &&
        result.native_acceptance === "not-established",
    );
    return result;
  };
  const sourceAllowance = Math.min(90000, Math.floor(deadline - performance.now())),
    sourceRoot = path.join(root, "windows-source"),
    source = path.join(sourceRoot, "source"),
    harness = await readControllerToolFile(
      path.join(project, nativeQualificationWorkerPath),
      1024 ** 2,
    ),
    sourceResult = await run(
      "source",
      {
        schema_version: 1,
        binding,
        source_commit: context.source,
        source_tree: tree,
        harness_sha256: digest(harness),
        root: sourceRoot,
        setup: path.join(tools, setupName),
        expires_at: Date.now() + sourceAllowance,
      },
      sourceAllowance,
    );
  assert.equal(sourceResult.source_commit, context.source);
  assert.equal(sourceResult.source_tree, tree);
  const treeBytes = await readControllerToolFile(path.join(sourceRoot, "tree.bin"), 4 * 1024 ** 2);
  assert.equal(digest(treeBytes), sourceResult.tree_inventory_sha256);
  const entries = inspectWindowsNativeSourceTree(treeBytes);
  verifyWindowsNativeSourceFiles(source, entries, digest(harness), active);
  const dependencyDeadline = Math.min(
      deadline,
      performance.now() + hostedWindowsDependencyPreparationMilliseconds,
    ),
    inputs = await inspectWindowsNativeDependencyInputs(source, dependencyDeadline, active),
    dependencies = await run(
      "dependencies",
      {
        schema_version: 1,
        binding,
        root: path.join(root, "windows-dependencies"),
        setup: path.join(tools, setupName),
        source,
        pnpm: path.join(tools, "bin/pnpm.exe"),
        inputs,
        expires_at: Date.now() + Math.floor(dependencyDeadline - performance.now()),
      },
      Math.floor(dependencyDeadline - performance.now()),
    );
  const graph = await snapshotWindowsNativeDependencies(source, deadline, active);
  assert.deepEqual(dependencies.inputs, inputs);
  assert.equal(graph.sha256, dependencies.graph_sha256);
  assert.equal(graph.entries, dependencies.entries);
  assert.equal(graph.bytes, dependencies.bytes);
  verifyWindowsNativeSourceFiles(source, entries, digest(harness), active);
  const { readFixtureModuleClosure } = await import("./fixtures/module-closure.mts");
  const modules = readFixtureModuleClosure(
    source,
    ["scripts/release-hosted-native-windows-diagnostic.mts"],
    { includeDynamicImports: false },
  );
  assert.deepEqual(
    modules.external.filter((name) => !isBuiltin(name)),
    ["yaml"],
    "Unreviewed original controller package import",
  );
  const yamlLink = graph.records.find((row) => row.path === path.join("node_modules", "yaml"));
  assert.ok(yamlLink && yamlLink.kind === "link" && typeof yamlLink.resolved === "string");
  const yamlRoot = yamlLink.resolved;
  const yamlFiles = graph.records.filter(
    (row) => row.kind === "file" && row.path.startsWith(yamlRoot + path.sep),
  );
  assert.ok(yamlFiles.length > 0 && yamlFiles.length <= 256);
  assert.ok(
    !graph.records.some((row) => row.kind === "link" && row.path.startsWith(yamlRoot + path.sep)),
    "Nested YAML package links are not a closed physical package",
  );
  const yamlPackage: unknown = JSON.parse(
      (await readControllerToolFile(path.join(source, yamlRoot, "package.json"), 65536)).toString(
        "utf8",
      ),
    ),
    rootPackage: unknown = JSON.parse(
      (await readControllerToolFile(path.join(source, "package.json"), 65536)).toString("utf8"),
    );
  assert.ok(
    isRecord(yamlPackage) &&
      yamlPackage.name === "yaml" &&
      isRecord(rootPackage) &&
      isRecord(rootPackage.devDependencies),
  );
  assert.equal(yamlPackage.version, rootPackage.devDependencies.yaml);
  const imports = [
    ...modules.modules.map((row) => ({
      path: row.path,
      bytes: row.bytes.length,
      sha256: row.sha256,
    })),
    ...yamlFiles.map((row) => {
      assert.ok(row.bytes !== undefined && row.sha256);
      return { path: row.path, bytes: row.bytes, sha256: row.sha256 };
    }),
    ...["package.json", "node_modules/.package-lock.json", "node_modules/.modules.yaml"]
      .filter(
        (name) =>
          name === "package.json" ||
          graph.records.some(
            (row) => row.kind === "file" && row.path === name.split("/").join(path.sep),
          ),
      )
      .map((name) => ({ path: name, bytes: 0, sha256: "" })),
  ];
  // Every resolution-controlling root manifest is hashed as data, never imported.
  for (const row of imports.filter((row) => row.sha256 === "")) {
    const bytes = await readControllerToolFile(path.join(source, row.path), 4 * 1024 ** 2);
    row.bytes = bytes.length;
    row.sha256 = digest(bytes);
  }
  assert.ok(imports.length > 0 && imports.length <= 512);
  const importCustody: {
    files: string[];
    custody: ReturnType<typeof inspectNativeRuntimeCustody>;
  }[] = [];
  for (let offset = 0; offset < imports.length; offset += 64) {
    active();
    const files = imports.slice(offset, offset + 64).map((row) => path.join(source, row.path));
    importCustody.push({ files, custody: inspectNativeRuntimeCustody(files) });
  }
  const recheckImports = () => {
    active();
    for (const batch of importCustody) {
      active();
      recheckNativeRuntimeCustody(batch.files, batch.custody);
    }
  };
  recheckImports();
  const linkInput = Buffer.from(
    JSON.stringify({ setup: path.join(tools, setupName), link: path.join(source, yamlLink.path) }),
  ).toString("base64");
  const yamlLinkNativeIdentity = execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference='Stop';$v=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${linkInput}'))|ConvertFrom-Json;Add-Type -TypeDefinition ([IO.File]::ReadAllText($v.setup));[Console]::Out.Write([Portcove.HostedNative.Setup]::LinkIdentity($v.link))`,
        "utf16le",
      ).toString("base64"),
    ],
    {
      env: {
        ...windowsOwnerEnvironment(source),
        RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID,
      },
      encoding: "utf8",
      timeout: Math.min(15000, Math.max(1, Math.floor(deadline - performance.now()))),
      maxBuffer: 4096,
      windowsHide: true,
    },
  );
  assert.match(yamlLinkNativeIdentity, /^[a-f0-9]{8}(?::[a-f0-9]{8}){4}$/u);
  assert.equal(
    (await snapshotWindowsNativeDependencies(source, deadline, active)).sha256,
    graph.sha256,
  );
  const copies: { path: string; bytes: number; sha256: string }[] = [];
  const copy = async (name: string, maximum: number) => {
    active();
    const before = await hashNativeCapturedFile(project, name, maximum, deadline),
      to = path.join(source, name);
    await capture(path.join(project, name), to, maximum);
    assert.deepEqual(await hashNativeCapturedFile(project, name, maximum, deadline), before);
    assert.deepEqual(await hashNativeCapturedFile(source, name, maximum, deadline), before);
    copies.push(before);
    assert.ok(
      copies.reduce((sum, row) => sum + row.bytes, 0) <= 1024 ** 3,
      "Complete copied same-job inputs exceed one GiB",
    );
  };
  for (const name of [
    "work/hosted-continuity-evidence/windows-runtime.json",
    "work/updater-rehearsal/rehearsal-result.json",
    "work/updater-rehearsal/windows-fixture-derivation.json",
    "work/updater-rehearsal/disposable.key.pub",
  ])
    await copy(name, name.endsWith(".pub") ? 16384 : 65536);
  await assert.rejects(lstat(path.join(project, "work/updater-rehearsal/disposable.key")), {
    code: "ENOENT",
  });
  for (const version of ["1.0.0-rc.2", "1.0.0"]) {
    for (const suffix of ["fixture.patch", "native.json"])
      await copy(
        `work/updater-rehearsal/${version}-${suffix}`,
        suffix.endsWith("patch") ? 512 * 1024 : 65536,
      );
    const directory = `work/updater-rehearsal/${version}-windows-x86_64`,
      names = await readdir(path.join(project, directory));
    assert.ok(names.length > 0 && names.length <= 8);
    for (const name of names) {
      assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/u);
      await copy(`${directory}/${name}`, 512 * 1024 ** 2);
      assert.ok(copies.reduce((sum, row) => sum + row.bytes, 0) <= 1024 ** 3);
    }
    await copy(
      `target/updater-rehearsal-cli-${version}/release/portcove-release-tools.exe`,
      128 * 1024 ** 2,
    );
  }
  recheck();
  const originalPaths = toolCachePaths({ projectRoot: project }),
    stateBytes = await readControllerToolFile(originalPaths.statePath, 65536),
    originalState: unknown = JSON.parse(stateBytes.toString("utf8")),
    runtime = inspectSupportedHostedWindowsRuntimeInput(
      await readControllerToolFile(
        path.join(source, "apps/desktop/src-tauri/src/runtime_support.rs"),
        65536,
      ),
      await readControllerToolFile(
        path.join(source, "work/hosted-continuity-evidence/windows-runtime.json"),
        65536,
      ),
      { source: context.source, workflow: context.workflow, run_id: context.run_id, attempt: "1" },
    ),
    scopedEnvironment = { ...process.env, PORTCOVE_SHARED_TOOL_CACHE: path.join(root, "cache") },
    scopedPaths = toolCachePaths({ projectRoot: source, environment: scopedEnvironment });
  assert.ok(isRecord(originalState) && isRecord(originalState.desktop));
  assert.equal(originalState.pin_fingerprint, originalPaths.pins.fingerprint);
  assert.equal(originalState.shared_root, originalPaths.sharedRoot);
  const desktop = originalState.desktop,
    pins = scopedPaths.pins.bootstrap.desktop;
  assert.ok(pins);
  assert.equal(desktop.native_driver_version, runtime.observed);
  assert.equal(desktop.webview2_version, runtime.observed);
  assert.equal(desktop.tauri_driver_version, pins.tauri_driver);
  const originalNative = path.join(
      originalPaths.sharedRoot,
      "desktop/msedgedriver",
      runtime.observed,
      "x64/msedgedriver.exe",
    ),
    originalTauri = path.join(
      originalPaths.cargoRoot,
      "tauri-driver",
      pins.tauri_driver,
      "bin/tauri-driver.exe",
    ),
    scopedNative = path.join(
      scopedPaths.sharedRoot,
      "desktop/msedgedriver",
      runtime.observed,
      "x64/msedgedriver.exe",
    ),
    scopedTauri = path.join(
      scopedPaths.cargoRoot,
      "tauri-driver",
      pins.tauri_driver,
      "bin/tauri-driver.exe",
    );
  assert.equal(desktop.native_driver, originalNative);
  assert.equal(desktop.tauri_driver, originalTauri);
  const driverCopies = [];
  for (const [from, to, expected] of [
    [originalNative, scopedNative, desktop.native_driver_sha256],
    [originalTauri, scopedTauri, desktop.tauri_driver_sha256],
  ] as const) {
    assert.ok(typeof expected === "string" && /^[a-f0-9]{64}$/iu.test(expected));
    const before = await hashNativeCapturedFile(
      originalPaths.sharedRoot,
      path.relative(originalPaths.sharedRoot, from),
      128 * 1024 ** 2,
      deadline,
    );
    assert.equal(before.sha256.toUpperCase(), expected.toUpperCase());
    await capture(from, to, 128 * 1024 ** 2);
    assert.deepEqual(
      await hashNativeCapturedFile(
        originalPaths.sharedRoot,
        before.path,
        128 * 1024 ** 2,
        deadline,
      ),
      before,
    );
    assert.equal(
      (
        await hashNativeCapturedFile(
          scopedPaths.sharedRoot,
          path.relative(scopedPaths.sharedRoot, to),
          128 * 1024 ** 2,
          deadline,
        )
      ).sha256,
      before.sha256,
    );
    driverCopies.push({ bytes: before.bytes, sha256: before.sha256 });
  }
  assert.ok(stateBytes.equals(await readControllerToolFile(originalPaths.statePath, 65536)));
  await mkdir(scopedPaths.shimDirectory, { recursive: true });
  for (const filename of [scopedPaths.statePath, scopedPaths.statePath + ".next"])
    await assert.rejects(lstat(filename), { code: "ENOENT" });
  const statePlan = {
    module: path.join(source, "scripts/tool-cache-state.psm1"),
    StatePath: scopedPaths.statePath,
    PinFingerprint: scopedPaths.pins.fingerprint,
    SharedRoot: scopedPaths.sharedRoot,
    ShimDirectory: scopedPaths.shimDirectory,
    Aqua: scopedPaths.aquaExecutable,
    AquaRoot: scopedPaths.aquaRoot,
    Desktop: {
      native_driver: scopedNative,
      native_driver_version: runtime.observed,
      native_driver_sha256: desktop.native_driver_sha256,
      webview2_version: runtime.observed,
      tauri_driver: scopedTauri,
      tauri_driver_version: pins.tauri_driver,
      tauri_driver_sha256: desktop.tauri_driver_sha256,
    },
  };
  // The same canonical writer as bootstrap; this caller appoints only a fresh
  // checkout-local observation and refuses retained state/partial .next above.
  const encoded = Buffer.from(JSON.stringify(statePlan)).toString("base64");
  execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference='Stop';$v=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json -AsHashtable;Import-Module -Name $v.module -Force;$v.Remove('module');Write-PortcoveToolCacheState @v`,
        "utf16le",
      ).toString("base64"),
    ],
    {
      env: {
        ...windowsOwnerEnvironment(source),
        PORTCOVE_SHARED_TOOL_CACHE: scopedPaths.sharedRoot,
      },
      timeout: Math.min(15000, Math.max(1, Math.floor(deadline - performance.now()))),
      maxBuffer: 16384,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  recheck();
  assert.ok(cachedDesktopDrivers({ projectRoot: source, environment: scopedEnvironment }));
  verifyWindowsNativeSourceFiles(source, entries, digest(harness), active);
  assert.equal(
    (await snapshotWindowsNativeDependencies(source, deadline, active)).sha256,
    graph.sha256,
  );
  const finalFiles = [
    ...runtimeFiles,
    ...copies.map((row) => path.join(source, row.path)),
    scopedNative,
    scopedTauri,
    scopedPaths.statePath,
    path.join(source, "scripts/windows-webview-driver-policy.psm1"),
    path.join(source, "scripts/tool-cache-state.psm1"),
    path.join(source, "scripts/release-hosted-native-windows-diagnostic.mts"),
  ];
  const finalCustody = inspectNativeRuntimeCustody(finalFiles);
  for (const row of copies)
    assert.deepEqual(
      await hashNativeCapturedFile(source, row.path, Math.max(1, row.bytes), deadline),
      row,
    );
  recheckNativeRuntimeCustody(finalFiles, finalCustody);
  recheckImports();
  recheck();
  assert.equal(git(["rev-parse", "HEAD"]), context.source);
  assert.equal(git(["rev-parse", "HEAD^{tree}"]), tree);
  git(["diff", "--quiet", "HEAD", "--"]);
  const nodeBytes = await readControllerToolFile(runtimeFiles[0]!, 128 * 1024 ** 2),
    controllerBytes = await readControllerToolFile(
      path.join(source, "scripts/release-hosted-native-windows-diagnostic.mts"),
      128 * 1024,
    ),
    launcherBytes = await readControllerToolFile(
      path.join(source, "scripts/release-hosted-native-windows-diagnostic-launch.ps1"),
      131072,
    ),
    preparedSetupBytes = await readControllerToolFile(path.join(source, setupName), 131072);
  const report = {
    schema_version: 1,
    source: context.source,
    tree,
    run_id: context.run_id,
    attempt: 1,
    workflow: context.workflow,
    root,
    prepared_source: source,
    node: runtimeFiles[0],
    node_sha256: digest(nodeBytes),
    controller_sha256: digest(controllerBytes),
    launcher_sha256: digest(launcherBytes),
    setup_sha256: digest(preparedSetupBytes),
    public_workspace: project,
    public_runner_temp: process.env.RUNNER_TEMP,
    shared_cache: scopedPaths.sharedRoot,
    runner_temp: path.join(root, "temp"),
    original_provider_job_id: provider.job_id,
    original_provider_started_at: provider.job_started_at,
    preparation_maximum_milliseconds: diagnosticPreparationMaximumMilliseconds,
    source_tree_inventory_sha256: digest(treeBytes),
    dependency_graph_sha256: graph.sha256,
    dependency_entries: graph.entries,
    dependency_bytes: graph.bytes,
    copies,
    imports,
    yaml_link: yamlLink,
    yaml_link_native_identity: yamlLinkNativeIdentity,
    drivers: driverCopies,
    authority: "none" as const,
    scope:
      "same-job protected diagnostic copies; no publisher authentication or production authority",
  };
  const reportBytes = Buffer.from(JSON.stringify(report));
  assert.ok(
    reportBytes.length > 0 && reportBytes.length <= 65536,
    "Prepared diagnostic locator exceeds bound",
  );
  recheck();
  recheckImports();
  const privateRecord = path.join(root, "preparation.json"),
    publicRecord = path.join(
      project,
      "work/hosted-continuity-evidence/windows-diagnostic-preparation.json",
    );
  await writeFile(privateRecord, reportBytes, { flag: "wx", flush: true, mode: 0o600 });
  active();
  const recordCustody = inspectNativeRuntimeCustody([privateRecord]);
  await writeFile(publicRecord, reportBytes, { flag: "wx", flush: true, mode: 0o600 });
  active();
  assert.ok(
    reportBytes.equals(await readControllerToolFile(privateRecord, 65536)),
    "Protected preparation record changed",
  );
  assert.ok(
    reportBytes.equals(await readControllerToolFile(publicRecord, 65536)),
    "Public preparation locator changed",
  );
  recheckNativeRuntimeCustody([privateRecord], recordCustody);
  recheckImports();
  recheck();
  return report;
}
