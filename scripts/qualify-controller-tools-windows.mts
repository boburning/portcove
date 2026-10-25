/** Credential-free source/tool qualification. Never a native or protected producer. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildControllerTools } from "./release-controller-tool-build.mts";
import {
  controllerToolEntries,
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
    const git = (arg: string) => {
      const result = spawnSync("git", ["rev-parse", arg], {
        cwd: source,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 4096,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "NUL",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      return result.stdout.trim();
    };
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
    phase = "actual-Windows-build";
    const built = await buildControllerTools(source, buildParent, expected);
    assert.equal(built.manifest.platform, "windows-x86_64");
    await record("manifest.json", built.manifest);
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
    phase = "actual-hosted-Windows-account-primitives";
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
          path.join(built.tools, "scripts/release-hosted-native-windows-setup.ps1"),
          "-ContextBase64",
          Buffer.from(JSON.stringify(context)).toString("base64"),
        ],
        {
          cwd: source,
          environment: {
            ...environment,
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
            runRustTests(args, { ...dependencies, ...prepared, tempRoot: buildParent }),
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
    assert.equal(account.job_empty, true);
    assert.equal(account.root_exited, true);
    assert.deepEqual(account.remaining_pids, []);
    assert.deepEqual(account.cleanup_failures, []);
    assert.ok(isRecord(account.root_identity) && isRecord(account.observed));
    assert.equal(account.root_identity.pid, account.observed.pid);
    assert.equal(account.failure, null);
    assert.equal(account.authority, "none");
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
