/** Credential-free source/tool qualification. Never a native or protected producer. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildControllerTools,
  controllerBootstrapEnvironment,
  materializeControllerNativeSupport,
} from "./release-controller-tool-build.mts";
import {
  controllerToolEntries,
  controllerToolSourceAssetMaximumBytes,
  controllerToolPlatformProfile,
  readControllerToolFile,
} from "./release-controller-tools.mts";
import { controllerNodeVersion } from "./controller-node-runtime.mts";
import { qualifyNativePnpmRuntime } from "./release-pnpm-runtime.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import { readCatalogCoreMachineEnvelope } from "./release-catalog-inspection.mts";
import {
  nativeRuntimeSupportProfile,
  inspectNativeRuntimeSupport,
  preparedNativeSupportDependencies,
} from "./release-native-runtime-support.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { isRecord } from "./runtime-values.mts";
import { isDeepStrictEqual } from "node:util";
import { observeWindowsAccountCommand } from "./release-hosted-native-windows-observation.mts";

function hostedWindowsGit(source: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: source,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 4096,
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  return result.stdout.trim();
}
function assertHostedWindowsSource(source: string, expected: { commit: string; tree: string }) {
  assert.equal(
    hostedWindowsGit(source, ["rev-parse", "HEAD"]),
    expected.commit,
    "Original primitive source commit changed",
  );
  assert.equal(
    hostedWindowsGit(source, ["rev-parse", "HEAD^{tree}"]),
    expected.tree,
    "Original primitive source tree changed",
  );
  assert.equal(
    hostedWindowsGit(source, ["status", "--porcelain=v1", "--untracked-files=no"]),
    "",
    "Original primitive source has tracked changes",
  );
}

export const hostedWindowsAccountSourcePaths = Object.freeze([
  "scripts/release-hosted-native-windows-setup.ps1",
  "scripts/release-hosted-native-windows-setup.cs.txt",
  "scripts/native-qualification-account.cs.txt",
  "scripts/native-qualification-account-registry.ps1",
  "scripts/fixtures/native-account-gui-probe.ps1",
] as const);

/** Source-only inert diagnostic inputs, never a controller-tool manifest. */
export async function stageHostedWindowsAccountSource(
  source: string,
  tools: string,
  expected: { commit: string; tree: string },
) {
  assertHostedWindowsSource(source, expected);
  const files = [];
  for (const name of hostedWindowsAccountSourcePaths) {
    const bytes = await readControllerToolFile(
      path.join(source, name),
      controllerToolSourceAssetMaximumBytes,
    );
    await mkdir(path.dirname(path.join(tools, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(tools, name), bytes, { flag: "wx", mode: 0o600 });
    files.push({
      path: name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const manifest = {
    schema_version: 1,
    purpose: "ordinary-hosted-account-source",
    source_commit: expected.commit,
    source_tree: expected.tree,
    platform: "windows-x86_64",
    files,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  assert.ok(bytes.length <= 65536);
  await writeFile(path.join(tools, "native-account-source.json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

async function main() {
  assert.ok(process.argv.length === 2 && process.platform === "win32" && process.arch === "x64");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, "boburning/portcove");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.versions.node, controllerNodeVersion);
  assert.ok(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN);
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
  const source = fileURLToPath(new URL("..", import.meta.url));
  const directory = path.join(process.env.RUNNER_TEMP, "controller-tools-windows-fixture");
  await mkdir(directory);
  // Use the same private home ancestry already qualified by Windows custody
  // fixtures, rather than assuming that a shared temp ancestor is protected.
  const buildParent = await mkdtemp(path.join(homedir(), ".pct-"));
  const record = async (name: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    assert.ok(bytes.length <= 65536);
    await writeFile(path.join(directory, name), bytes, { flag: "wx" });
  };
  let phase = "source";
  try {
    const git = (arg: string) => hostedWindowsGit(source, ["rev-parse", arg]);
    const expected = { commit: git("HEAD"), tree: git("HEAD^{tree}") };
    assert.equal(expected.commit, process.env.FIXTURE_SOURCE_SHA);
    await record("source.json", {
      ...expected,
      workflow: process.env.GITHUB_WORKFLOW_REF,
      run_id: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      scope: "ordinary-hosted-Windows-tool-build",
      authority: "none",
    });
    phase = "source-only-Windows-account-primitives";
    const primitiveTools = await mkdtemp(path.join(buildParent, "gui-"));
    const primitiveSource = await stageHostedWindowsAccountSource(source, primitiveTools, expected);
    await record("account-source.json", primitiveSource);
    const primitiveSupport = nativeRuntimeSupportProfile("windows-x86_64");
    await mkdir(path.join(primitiveTools, "bin"), { mode: 0o700 });
    await mkdir(path.join(primitiveTools, "home"), { mode: 0o700 });
    const primitiveNode = await readControllerToolFile(process.execPath);
    const primitiveNodeIdentity = {
      path: "bin/node.exe",
      bytes: primitiveNode.length,
      sha256: createHash("sha256").update(primitiveNode).digest("hex"),
    };
    await writeFile(path.join(primitiveTools, "bin/node.exe"), primitiveNode, {
      flag: "wx",
      mode: 0o700,
    });
    await mkdir(path.dirname(path.join(primitiveTools, primitiveSupport.source)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      path.join(primitiveTools, primitiveSupport.source),
      await readControllerToolFile(path.join(source, primitiveSupport.source), 65536),
      { flag: "wx", mode: 0o600 },
    );
    await materializeControllerNativeSupport(
      source,
      primitiveTools,
      controllerBootstrapEnvironment(
        path.join(primitiveTools, "home"),
        path.join(primitiveTools, "target"),
      ),
      "windows-x86_64",
    );
    const primitiveFiles = [
      ...primitiveSource.files.map((file) => path.join(primitiveTools, file.path)),
      "native-account-source.json",
      "bin/node.exe",
      primitiveSupport.source,
      primitiveSupport.binary,
      primitiveSupport.metadata,
    ].map((name) => (path.isAbsolute(name) ? name : path.join(primitiveTools, name)));
    const primitiveCustody = inspectNativeRuntimeCustody(primitiveFiles);
    const primitiveSupportSource = await readControllerToolFile(
      path.join(primitiveTools, primitiveSupport.source),
      65536,
    );
    const primitiveSupportBinary = await readControllerToolFile(
      path.join(primitiveTools, primitiveSupport.binary),
      primitiveSupport.maximumBinaryBytes,
    );
    const primitiveSupportMetadata = inspectNativeRuntimeSupport(
      JSON.parse(
        (
          await readControllerToolFile(path.join(primitiveTools, primitiveSupport.metadata), 65536)
        ).toString("utf8"),
      ),
      primitiveSupportSource,
      primitiveSupportBinary,
      "windows-x86_64",
    );
    await record("account-support.json", {
      source: expected,
      node: primitiveNodeIdentity,
      support: primitiveSupportMetadata,
      scope: "source-only original supervisor; no packaged product or protected/native acceptance",
      authority: "none",
    });
    let primitiveStopped = false;
    const primitivePrepared = preparedNativeSupportDependencies(
      {
        caller_root: source,
        output_parent: buildParent,
        source_file: path.join(primitiveTools, primitiveSupport.source),
        source: primitiveSupportSource,
        binary: primitiveSupportBinary,
        metadata: primitiveSupportMetadata,
      },
      () => {
        assert.ok(!primitiveStopped);
        recheckNativeRuntimeCustody(primitiveFiles, primitiveCustody);
      },
      () => {
        primitiveStopped = true;
      },
      "windows-x86_64",
    );
    const primitiveEnvironment = {
      SystemRoot: process.env.SystemRoot,
      PATH: `${path.join(primitiveTools, "bin")};${process.env.SystemRoot}\\System32`,
      HOME: directory,
      USERPROFILE: directory,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    };

    const broker = readProcessIdentity(process.pid);
    assert.ok(broker && broker.startsWith(`win32:${process.pid}:`));
    const context = {
      schema_version: 1,
      source_commit: expected.commit,
      source_tree: expected.tree,
      binding: randomBytes(32).toString("hex"),
      broker_pid: process.pid,
      broker_created_ticks: broker.split(":")[2],
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: 1,
    };
    assertHostedWindowsSource(source, expected);
    recheckNativeRuntimeCustody(primitiveFiles, primitiveCustody);
    const stdout = openSync(path.join(directory, "account.stdout.bin"), "wx");
    const stderr = openSync(path.join(directory, "account.stderr.bin"), "wx");
    let accountStatus: number | undefined;
    let accountError: unknown;
    try {
      accountStatus = await runResourceCommand(
        "analysis",
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.join(primitiveTools, "scripts/release-hosted-native-windows-setup.ps1"),
          "-ContextBase64",
          Buffer.from(JSON.stringify(context)).toString("base64"),
        ],
        {
          cwd: source,
          environment: {
            ...primitiveEnvironment,
            GITHUB_ACTIONS: "true",
            GITHUB_REPOSITORY: "boburning/portcove",
            RUNNER_ENVIRONMENT: "github-hosted",
            GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
            GITHUB_WORKFLOW_REF: process.env.GITHUB_WORKFLOW_REF,
            GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
            GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
            SystemDrive: process.env.SystemDrive,
          },
          output: { stdout, stderr },
          executionTimeoutMilliseconds: 145000,
          supervise: (args, dependencies) =>
            runRustTests(args, { ...dependencies, ...primitivePrepared, tempRoot: buildParent }),
        },
      );
    } catch (error) {
      accountError = error;
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    const readbackFailures: string[] = [];
    for (const name of [
      "intent.json",
      "account-created.json",
      "result.json",
      "capture/observed.json",
      "capture/startup.json",
      "capture/security-before-launch.json",
      "capture/startup-token.json",
      "capture/startup-threads.json",
      "capture/startup-position.json",
      "capture/startup-popup.json",
      "capture/station-recovery.json",
    ]) {
      const filename = path.join("C:\\ProgramData\\PortcoveHostedNativeQualification", name);
      try {
        const bytes = await readControllerToolFile(filename, 65536);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        assert.ok(
          isRecord(value) && isDeepStrictEqual(value.context, context),
          "retained account evidence belongs to another attempt",
        );
        await record(`account-${path.basename(name)}`, value);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          readbackFailures.push(
            error instanceof Error ? error.message.slice(0, 1024) : "account evidence read refused",
          );
      }
    }
    const command = await observeWindowsAccountCommand(
      directory,
      accountStatus,
      accountError,
      readbackFailures,
    );
    await record("account-command.json", command);
    if (accountError !== undefined) {
      if (accountError instanceof Error) throw accountError;
      throw new Error("hosted account resource operation refused", { cause: accountError });
    }
    assert.deepEqual(readbackFailures, []);
    assert.equal(command.stderr.observation, "read");
    assert.equal(
      accountStatus,
      0,
      "hosted account command failed; inspect retained account-command.json",
    );
    const account: unknown = JSON.parse(
      (await readControllerToolFile(path.join(directory, "account-result.json"), 65536)).toString(
        "utf8",
      ),
    );
    assert.ok(isRecord(account));
    assert.deepEqual(account.context, context);
    assert.equal(account.disabled, true);
    assert.equal(account.initial_suspend_count, 1);
    assert.equal(account.job_empty, true);
    assert.equal(account.station_restored, true);
    assert.equal(account.observer_drained, true);
    assert.match(String(account.hosted_desktop), /^PortcoveHosted_[0-9a-f]{32}$/u);
    assert.match(String(account.response_inspection), /^[1-9][0-9]*:[1-9][0-9]*:[0-9]+$/u);
    assert.equal(account.root_exited, true);
    assert.deepEqual(account.remaining_pids, []);
    assert.deepEqual(account.cleanup_failures, []);
    assert.ok(isRecord(account.root_identity) && isRecord(account.observed));
    assert.equal(account.root_identity.pid, account.observed.pid);
    assert.equal(account.failure, null);
    assert.equal(account.authority, "none");
    recheckNativeRuntimeCustody(primitiveFiles, primitiveCustody);
    phase = "actual-Windows-build";
    const built = await buildControllerTools(source, buildParent, expected);
    assert.equal(built.manifest.platform, "windows-x86_64");
    await record("manifest.json", built.manifest);
    for (const file of [
      ...primitiveSource.files,
      primitiveNodeIdentity,
      { path: primitiveSupport.source, ...primitiveSupportMetadata.source },
    ]) {
      const packed = built.manifest.files.find((entry) => entry.path === file.path);
      assert.ok(
        packed && packed.bytes === file.bytes && packed.sha256 === file.sha256,
        "Packaged account source differs from original primitive",
      );
    }
    await record("account-source-join.json", {
      source: expected,
      files: primitiveSource.files,
      node: primitiveNodeIdentity,
      supervisor_source: primitiveSupportMetadata.source,
      matched_packaged_source: true,
      scope:
        "source-only inert GUI evidence joined by exact packaged bytes; no protected/native acceptance",
      authority: "none",
    });
    const files = [
      ...built.manifest.files.map((file) => path.join(built.tools, file.path)),
      path.join(built.tools, "manifest.json"),
    ];
    const custody = inspectNativeRuntimeCustody(files);
    for (const file of built.manifest.files) {
      const bytes = await readControllerToolFile(path.join(built.tools, file.path), file.bytes);
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
    const environment = {
      SystemRoot: process.env.SystemRoot,
      PATH: `${path.join(built.tools, "bin")};${process.env.SystemRoot}\\System32`,
      HOME: directory,
      USERPROFILE: directory,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    };
    const invoke = (name: string, args: string[]) => {
      const result = spawnSync(path.join(built.tools, "bin", name), args, {
        cwd: built.tools,
        env: environment,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
        windowsHide: true,
      });
      assert.equal(result.error, undefined, `${name} spawn failed`);
      return result;
    };
    phase = "actual-node-and-Core";
    const node = invoke("node.exe", ["--version"]);
    assert.equal(node.status, 0);
    assert.equal(node.stdout.trim(), `v${controllerNodeVersion}`);
    const cli = invoke("portcove.exe", ["--version"]);
    assert.equal(cli.status, 0);
    assert.match(cli.stdout, /^portcove \d+\.\d+\.\d+/u);
    const bundle = path.join(directory, "inert-publication"),
      library = path.join(directory, "unopened-library");
    await mkdir(path.join(bundle, "definitions"), { recursive: true });
    const index = Buffer.from('{"index_schema":1,"definitions":[],"contents":[]}');
    await writeFile(path.join(bundle, "definitions/index.json"), index, { flag: "wx" });
    const inspect = () =>
      invoke("portcove.exe", [
        "--library",
        library,
        "--json",
        "catalog",
        "inspect-definition-publication",
        bundle,
      ]);
    const read = inspect();
    assert.equal(read.status, 0, read.stderr);
    const report = readCatalogCoreMachineEnvelope(
      read.stdout,
      read.stderr,
      new Map([["definitions/index.json", index]]),
    );
    assert.equal(report.authority, "none");
    assert.deepEqual(report.definitions, []);
    await assert.rejects(lstat(library), { code: "ENOENT" });
    await writeFile(path.join(bundle, "extra.json"), "{}", { flag: "wx" });
    assert.notEqual(inspect().status, 0);
    await assert.rejects(lstat(library), { code: "ENOENT" });
    phase = "actual-release-tools-and-WebDriver";
    const rust = invoke("portcove-release-tools.exe", []);
    assert.equal(rust.status, 1);
    assert.match(rust.stderr, /usage: portcove-release-tools/u);
    const driver = invoke("tauri-driver.exe", ["--help"]);
    assert.equal(driver.status, 0);
    assert.match(driver.stdout, /tauri-driver/u);
    phase = "actual-Tauri-addon";
    const addon = invoke("node.exe", [
      "-e",
      'require(process.argv[1]).run(["--version"],"tauri",e=>{if(e)process.exitCode=1})',
      path.join(built.tools, "bin/tauri-addon.node"),
    ]);
    assert.equal(addon.status, 0, addon.stderr);
    assert.equal(addon.stdout.trim(), "tauri-cli 2.12.2");
    phase = "actual-offline-package-manager";
    const pnpm = await qualifyNativePnpmRuntime(
      path.join(built.tools, "bin/pnpm.exe"),
      path.join(directory, "pnpm-runtime"),
      path.join(built.tools, "bin"),
    );
    await record("pnpm-runtime.json", pnpm);
    phase = "actual-packed-refusals";
    for (const name of controllerToolEntries) {
      const result = invoke("node.exe", [path.join(built.tools, `scripts/${name}.bundle.mjs`)]);
      assert.notEqual(result.status, 0, name);
      assert.ok(result.stderr.trim(), name);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u, name);
    }
    phase = "actual-prepared-Windows-supervisor";
    const support = nativeRuntimeSupportProfile("windows-x86_64");
    const supportSource = await readControllerToolFile(
      path.join(built.tools, support.source),
      65536,
    );
    const supportBinary = await readControllerToolFile(
      path.join(built.tools, support.binary),
      support.maximumBinaryBytes,
    );
    const supportMetadata = inspectNativeRuntimeSupport(
      JSON.parse(
        (await readControllerToolFile(path.join(built.tools, support.metadata), 65536)).toString(
          "utf8",
        ),
      ),
      supportSource,
      supportBinary,
      "windows-x86_64",
    );
    let stopped = false;
    const prepared = preparedNativeSupportDependencies(
      {
        caller_root: source,
        output_parent: buildParent,
        source_file: path.join(built.tools, support.source),
        source: supportSource,
        binary: supportBinary,
        metadata: supportMetadata,
      },
      () => {
        assert.ok(!stopped);
        recheckNativeRuntimeCustody(files, custody);
      },
      () => {
        stopped = true;
      },
      "windows-x86_64",
    );
    const supervised = await runResourceCommand(
      "analysis",
      path.join(built.tools, "bin/node.exe"),
      ["-e", 'process.stdout.write("prepared-Windows-supervisor\\n")'],
      {
        cwd: source,
        environment: { ...environment, GITHUB_ACTIONS: "true" },
        executionTimeoutMilliseconds: 5000,
        supervise: (args, dependencies) =>
          runRustTests(args, { ...dependencies, ...prepared, tempRoot: buildParent }),
      },
    );
    assert.equal(supervised, 0);
    assert.equal(stopped, false);
    await record("prepared-supervisor.json", {
      status: supervised,
      product: support.product,
      sha256: supportMetadata.output.sha256,
      compiler_queries: "prepared-metadata-only",
      runtime_compilation: false,
      shared_cache_queries: false,
      scope: "inert resource-admitted child only; no candidate/native acceptance",
      authority: "none",
    });
    recheckNativeRuntimeCustody(files, custody);
    await record("result.json", {
      status: "pass",
      phase,
      source: expected,
      expanded_bytes: built.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      inventory: controllerToolPlatformProfile("windows-x86_64").paths,
      actual_executables: [
        "node.exe",
        "portcove.exe",
        "portcove-release-tools.exe",
        "tauri-driver.exe",
        "pnpm.exe",
        "tauri-addon.node",
      ],
      filesystem_custody: "actual-owner-ACL-and-identity-recheck",
      scope: "Windows controller-tool bootstrap only",
      native_acceptance: "not-established",
      production_tool_acceptance: "not-established",
      authority: "none",
    });
  } catch (error) {
    await record("result.json", {
      status: "fail",
      phase,
      build_parent: buildParent,
      failure: error instanceof Error ? error.message.slice(0, 4096) : "unknown fixture failure",
      automatic_retry: false,
      authority: "none",
    });
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Windows tool qualification refused");
    process.exitCode = 2;
  });
