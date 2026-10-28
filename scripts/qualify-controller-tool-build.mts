/** Ordinary credential-free hosted build fixture. Never a production tool route. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildControllerTools } from "./release-controller-tool-build.mts";
import {
  controllerToolEntries,
  controllerToolChildren,
  controllerCompilerSourceAsset,
  controllerNativeDriverVersion,
  readControllerToolFile,
} from "./release-controller-tools.mts";
import { inspectReleaseCompilerSourceClosure } from "./release-compiler-source-closure.mts";
import { readCatalogCoreMachineEnvelope } from "./release-catalog-inspection.mts";
import { controllerNodeVersion } from "./controller-node-runtime.mts";
import {
  inspectNativeDependencyWorkspace,
  qualifyNativePnpmRuntime,
} from "./release-pnpm-runtime.mts";
import { runResourceCommand } from "./resource-command.mts";
import {
  nativeRuntimeSupport,
  inspectNativeRuntimeSupport,
} from "./release-native-runtime-support.mts";
import { inspectLinuxSupervisor } from "./run-rust-tests.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";

/** Bound JSON escape expansion as well as process output; preserve full-byte identity. */
function boundedFixtureOutput(value: string) {
  const bytes = Buffer.from(value);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    prefix: value.slice(0, 1024),
    prefix_limit_code_units: 1024,
    truncated: value.length > 1024,
  };
}

/** Real fixed reaper -> bundled supervisor -> fixed driver, plus orphan closure.
 * Credential-free ordinary fixture only; neither case grants native acceptance. */
export async function qualifyNativeChildren(
  tools: string,
  directory: string,
  keyless?: { args: string[]; timeout: number },
) {
  const node = path.join(tools, "bin/node");
  const metadata = inspectNativeRuntimeSupport(
    JSON.parse(
      (
        await readControllerToolFile(path.join(tools, nativeRuntimeSupport.metadata), 65536)
      ).toString("utf8"),
    ),
    await readControllerToolFile(path.join(tools, nativeRuntimeSupport.source), 65536),
    await readControllerToolFile(
      path.join(tools, nativeRuntimeSupport.binary),
      nativeRuntimeSupport.maximumBinaryBytes,
    ),
  );
  for (const kind of keyless ? ["packed-keyless"] : ["driver-refusal", "orphan-closure"]) {
    const attempt = path.join(directory, kind);
    await mkdir(attempt, { mode: 0o700 });
    const gate = path.join(attempt, "gate"),
      status = path.join(attempt, "status.json"),
      receipt = path.join(attempt, "receipt.json"),
      registration = path.join(attempt, "registration.json");
    const args = keyless
      ? keyless.args
      : kind === "driver-refusal"
        ? [path.join(tools, "scripts/release-hosted-native-linux-driver.mts")]
        : [
            "--input-type=module",
            "--eval",
            `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],String(c.pid),{flag:'wx'});c.unref();`,
            path.join(attempt, "orphan-pid"),
          ];
    const parentIdentity = readProcessIdentity(process.pid, { platform: "linux" });
    assert.ok(parentIdentity);
    const child = spawn(
      path.join(tools, nativeRuntimeSupport.binary),
      [
        gate,
        status,
        receipt,
        registration,
        parentIdentity,
        node,
        path.join(tools, "scripts/rust-test-tree-supervisor.mts"),
        node,
        ...args,
      ],
      {
        cwd: tools,
        env: { HOME: attempt, TMPDIR: attempt, GITHUB_ACTIONS: "true", RUNNER_TEMP: attempt },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "",
      outputBytes = 0,
      expired = false,
      settled = false;
    let orphanPid: number | null = null;
    child.stdin.on("error", () => {}); // Exit/receipt checks decide success; pipe loss never does.
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes: Buffer) => {
        outputBytes += bytes.length;
        if (stream === child.stderr && outputBytes <= 65536) stderr += bytes.toString("utf8");
        if (outputBytes > 65536) child.stdin.end();
      });
    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once("error", (error) => {
        settled = true;
        resolve({ code: null, error });
      });
      child.once("close", (code) => {
        settled = true;
        resolve({ code });
      });
    });
    let settlementTimer: ReturnType<typeof setTimeout>;
    const finished = Promise.race([
      exited,
      new Promise<{ code: null; error: Error }>((resolve) => {
        settlementTimer = setTimeout(
          () =>
            resolve({
              code: null,
              error: new Error("fixed reaper settlement unknown; retain attempt"),
            }),
          (keyless?.timeout ?? 8000) + 6000,
        );
      }),
    ]);
    const timeout = setTimeout(() => {
      expired = true;
      child.stdin.end();
    }, keyless?.timeout ?? 8000);
    try {
      const until = performance.now() + 5000;
      let registered = false;
      while (performance.now() < until) {
        try {
          inspectLinuxSupervisor(
            JSON.parse((await readControllerToolFile(registration, 4096)).toString("utf8")),
            child.pid,
          );
          registered = true;
          break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(registered, "fixed prepared reaper registration missing");
      await writeFile(gate, "go", { flag: "wx", mode: 0o600 });
      const result = await finished;
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.code, 0, stderr);
      assert.equal(expired, false);
      assert.ok(outputBytes <= 65536);
      assert.deepEqual(JSON.parse((await readControllerToolFile(receipt, 4096)).toString("utf8")), {
        outcome: "quiescent",
      });
      assert.deepEqual(JSON.parse((await readControllerToolFile(status, 4096)).toString("utf8")), {
        exit_code: kind === "driver-refusal" ? 1 : 0,
      });
      if (kind === "driver-refusal") {
        assert.match(stderr, /fixed hosted Linux driver arguments required/u);
        assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u);
      } else if (kind === "orphan-closure") {
        const pid = Number(
          (await readControllerToolFile(path.join(attempt, "orphan-pid"), 32)).toString("utf8"),
        );
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        orphanPid = pid;
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    } finally {
      clearTimeout(timeout);
      child.stdin.end();
      const result = await finished;
      clearTimeout(settlementTimer!);
      await writeFile(
        path.join(attempt, "fixture-settlement.json"),
        JSON.stringify({
          kind,
          reaper_pid: child.pid,
          settled,
          exit_code: result.code,
          error: result.error?.message ?? null,
          expired,
          output_bytes: outputBytes,
          stderr,
          orphan_pid: orphanPid,
          authority: "none",
          native_acceptance: "not-established",
        }),
        { flag: "wx", mode: 0o600 },
      );
      if (!settled) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      assert.ok(settled, "fixed prepared reaper settlement unknown; retain attempt");
    }
  }
  return {
    support_sha256: metadata.output.sha256,
    chain: keyless
      ? "prepared-reaper/bundled-supervisor/packed-keyless"
      : "prepared-reaper/bundled-supervisor/fixed-driver-refusal",
    orphan_closure: keyless ? "not-exercised" : "quiescent",
    native_acceptance: "not-established",
  };
}

async function main() {
  const source = fileURLToPath(new URL("..", import.meta.url));
  const temp = process.env.RUNNER_TEMP;
  if (process.argv.length !== 2 || process.platform !== "linux" || !temp || !path.isAbsolute(temp))
    throw new Error("fixed Linux hosted build fixture required");
  const directory = path.join(temp, "controller-tool-build-fixture");
  await mkdir(directory, { mode: 0o700 });
  const buildWork = path.join(directory, "build-work");
  await mkdir(buildWork, { mode: 0o700 });
  let phase = "source";
  const record = (name: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 64 * 1024) throw new Error("fixture public evidence exceeds bound");
    return writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
  };
  let builtDirectory: string | null = null;
  let buildMilliseconds: number | null = null;
  const nodeRuntime = { expected: controllerNodeVersion, observed: process.versions.node };
  try {
    const git = (argument: string) => {
      const result = spawnSync("git", ["rev-parse", argument], {
        cwd: source,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      if (result.status !== 0 || result.error) throw new Error("fixture source unavailable");
      return result.stdout.trim();
    };
    const expected = { commit: git("HEAD"), tree: git("HEAD^{tree}") };
    assert.equal(expected.commit, process.env.FIXTURE_SOURCE_SHA);
    await record("source.json", {
      schema_version: 1,
      ...expected,
      evidence_scope: "ordinary-hosted-fixture",
      authority: "none",
    });
    phase = "fixed-node-runtime";
    assert.equal(nodeRuntime.observed, nodeRuntime.expected);
    phase = "actual-fixed-build";
    const buildStarted = performance.now();
    const built = await buildControllerTools(source, buildWork, expected);
    buildMilliseconds = Math.ceil(performance.now() - buildStarted);
    builtDirectory = built.directory;
    await record("manifest.json", built.manifest);
    phase = "opaque-tool-readback";
    for (const file of built.manifest.files) {
      const bytes = await readControllerToolFile(path.join(built.tools, file.path));
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
    phase = "actual-compiler-source-closure";
    const closure = inspectReleaseCompilerSourceClosure(
      JSON.parse(
        (
          await readControllerToolFile(path.join(built.tools, controllerCompilerSourceAsset), 65536)
        ).toString("utf8"),
      ) as unknown,
    );
    assert.equal(closure.source_commit, expected.commit);
    assert.equal(closure.source_tree, expected.tree);
    const env = {
      HOME: directory,
      USERPROFILE: directory,
      TEMP: directory,
      TMP: directory,
      TMPDIR: directory,
    };
    const invoke = (executable: string, args: string[]) =>
      spawnSync(executable, args, {
        cwd: built.tools,
        env,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
    phase = "actual-node-runtime";
    const node = path.join(built.tools, "bin/node");
    const nodeResult = invoke(node, ["--version"]);
    assert.equal(nodeResult.error, undefined);
    assert.equal(nodeResult.status, 0);
    assert.equal(nodeResult.stdout.trim(), `v${controllerNodeVersion}`);
    phase = "actual-native-package-manager";
    const pnpmRuntime = await qualifyNativePnpmRuntime(
      path.join(built.tools, "bin/pnpm"),
      path.join(directory, "pnpm-runtime"),
      path.join(built.tools, "bin"),
    );
    await record("pnpm-runtime.json", pnpmRuntime);
    phase = "actual-frozen-native-dependencies";
    const dependencyRoot = path.join(directory, "frozen-native-graph");
    await mkdir(dependencyRoot, { mode: 0o700 });
    const nativeSource = path.join(dependencyRoot, "native-source");
    const fixtureGit = (args: string[]) => {
      const result = spawnSync(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.file.allow=always",
          ...args,
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: directory,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_NO_LAZY_FETCH: "1",
            GIT_NO_REPLACE_OBJECTS: "1",
          },
          encoding: "utf8",
          timeout: 20000,
          maxBuffer: 65536,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
    };
    fixtureGit([
      "clone",
      "--quiet",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      "--template=",
      source,
      nativeSource,
    ]);
    fixtureGit(["-C", nativeSource, "checkout", "--quiet", "--detach", expected.commit]);
    const workspace = inspectNativeDependencyWorkspace(
      await readControllerToolFile(path.join(nativeSource, "pnpm-workspace.yaml"), 65536),
    );
    const toolIdentity = async (filename: string) => {
      const bytes = await readControllerToolFile(filename);
      return {
        path: filename,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const dependencyPlan = {
      schema_version: 1,
      binding: "f".repeat(64),
      source_commit: expected.commit,
      source_tree: expected.tree,
      harness_sha256: createHash("sha256")
        .update(
          await readControllerToolFile(
            path.join(nativeSource, "apps/desktop/scripts/desktop-test.mts"),
            1024 ** 2,
          ),
        )
        .digest("hex"),
      broker_uid: process.getuid!(),
      broker_pid: process.pid,
      broker_identity: readProcessIdentity(process.pid, { platform: "linux" }),
      deadline_ns: String(process.hrtime.bigint() + 90_000_000_000n),
      tools: {
        node: await toolIdentity(node),
        driver: await toolIdentity(path.join(built.tools, "bin/tauri-driver")),
      },
      context: {
        GITHUB_SHA: expected.commit,
        GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW_REF:
          "boburning/portcove/.github/workflows/application-update-production.yml@refs/tags/portcove-production-controller-fixture",
      },
    };
    const dependencySettings = {
      pnpm: await toolIdentity(path.join(built.tools, "bin/pnpm")),
      workspace_sha256: workspace.sha256,
      patches: workspace.patches,
    };
    const dependencyStarted = performance.now();
    const dependencyRemaining = Math.floor(
      Number(BigInt(dependencyPlan.deadline_ns) - process.hrtime.bigint()) / 1e6,
    );
    assert.ok(dependencyRemaining > 0);
    const dependencyStatus = await runResourceCommand(
      "analysis",
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import importlib.util,json,sys; from pathlib import Path; spec=importlib.util.spec_from_file_location('fixture_installation',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.WORKSPACE=Path(sys.argv[2]); result=m.prepare_source_dependencies(m.inspect_plan(json.loads(sys.argv[3])),json.loads(sys.argv[4])); Path(sys.argv[5]).write_text(json.dumps({'scope':'ordinary-hosted-frozen-graph-fixture','result':result,'authority':'none'}))",
        path.join(built.tools, "scripts/prepare-hosted-native-linux-installation.py"),
        dependencyRoot,
        JSON.stringify(dependencyPlan),
        JSON.stringify(dependencySettings),
        path.join(directory, "pnpm-frozen-graph.json"),
      ],
      {
        cwd: source,
        environment: {
          // The existing supervisor must resolve the same installed compiler
          // used by the tool build. The Python install creates its own clean env.
          PATH: process.env.PATH,
          RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(homedir(), ".rustup"),
          CARGO_HOME: process.env.CARGO_HOME ?? path.join(homedir(), ".cargo"),
          HOME: directory,
          LANG: "C.UTF-8",
          // Retain only the observed public-runner routing signal. Otherwise
          // the supervisor mistakes this credential-free child for local work.
          ...(process.env.GITHUB_ACTIONS === "true" ? { GITHUB_ACTIONS: "true" } : {}),
        },
        executionTimeoutMilliseconds: dependencyRemaining + 5000,
        queueDeadline: performance.now() + dependencyRemaining,
      },
    );
    assert.equal(
      dependencyStatus,
      0,
      "actual frozen graph preparation refused; retain partial fixture",
    );
    await record("pnpm-frozen-graph-timing.json", {
      milliseconds: Math.ceil(performance.now() - dependencyStarted),
      allocation_milliseconds: 90000,
      cleanup_milliseconds: 5000,
      scope: "ordinary-hosted-frozen-graph-fixture",
      authority: "none",
    });
    phase = "actual-native-webdriver";
    const nativeDriver = path.join(built.tools, "bin/tauri-driver");
    // The pinned upstream CLI has no version flag. Build provenance supplies
    // the pin; its inert refusal/help interface is the actual runtime smoke.
    const driverVersion = invoke(nativeDriver, ["--version"]);
    const driverHelp = invoke(nativeDriver, ["--help"]);
    await record("native-driver-smoke.json", {
      pinned_build_version: controllerNativeDriverVersion,
      version_source: "fixed Cargo install pin, not an executable version query",
      unsupported_version: {
        status: driverVersion.status,
        error: driverVersion.error?.message ?? null,
        stdout: boundedFixtureOutput(driverVersion.stdout),
        stderr: boundedFixtureOutput(driverVersion.stderr),
      },
      help: {
        status: driverHelp.status,
        error: driverHelp.error?.message ?? null,
        stdout: boundedFixtureOutput(driverHelp.stdout),
        stderr: boundedFixtureOutput(driverHelp.stderr),
      },
      native_acceptance: "not-established",
      authority: "none",
    });
    assert.equal(driverVersion.error, undefined);
    assert.equal(driverVersion.status, 1);
    assert.match(driverVersion.stderr, /unused arguments left:.*--version/u);
    assert.equal(driverHelp.error, undefined);
    assert.equal(driverHelp.status, 0);
    assert.match(driverHelp.stdout, /--native-driver/u);
    phase = "actual-tauri-addon-help";
    const addon = path.join(built.tools, "bin/tauri-addon.node");
    const tauri = (args: string[]) =>
      invoke(node, [
        "-e",
        'require(process.argv[1]).run(JSON.parse(process.argv[2]),"tauri",e=>{if(e)process.exitCode=1})',
        addon,
        JSON.stringify(args),
      ]);
    const version = tauri(["--version"]);
    assert.equal(version.error, undefined);
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), "tauri-cli 2.12.2");
    const signHelp = tauri(["signer", "sign", "--help"]);
    assert.equal(signHelp.error, undefined);
    assert.equal(signHelp.status, 0);
    assert.match(signHelp.stdout, /--app-version/u);
    const buildHelp = tauri(["build", "--help"]);
    assert.equal(buildHelp.error, undefined);
    assert.equal(buildHelp.status, 0);
    assert.match(buildHelp.stdout, /--no-sign/u);
    phase = "actual-bundle-refusal-smoke";
    for (const name of controllerToolEntries) {
      const result = invoke(node, [path.join(built.tools, "scripts", `${name}.bundle.mjs`)]);
      assert.equal(result.error, undefined);
      assert.equal(
        result.status,
        [
          "release-control-ready",
          "release-payload-preparation",
          "release-signing-controller",
          "release-hosted-native-runner",
          "release-hosted-native-worker",
        ].includes(name)
          ? 2
          : 1,
        name,
      );
      assert.ok(result.stderr.trim(), name);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u);
    }
    phase = "actual-fixed-native-worker-source-refusal";
    const nativeWorkerRefusal = invoke(node, [
      path.join(built.tools, "scripts/release-hosted-native-worker.bundle.mjs"),
      "run",
    ]);
    assert.equal(nativeWorkerRefusal.error, undefined);
    assert.equal(nativeWorkerRefusal.status, 2);
    assert.match(nativeWorkerRefusal.stderr, /fixed hosted native supervision refused/u);
    assert.doesNotMatch(nativeWorkerRefusal.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u);
    phase = "actual-fixed-native-child-refusal";
    for (const filename of controllerToolChildren) {
      const result = spawnSync(node, [path.join(built.tools, filename)], {
        cwd: built.tools,
        env: { ...env, GITHUB_ACTIONS: "true" },
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
      });
      assert.equal(result.error, undefined);
      assert.equal(
        result.status,
        filename.endsWith("rust-test-tree-supervisor.mts") ||
          filename.endsWith("release-hosted-native-bootstrap.mts")
          ? 2
          : 1,
      );
      assert.ok(result.stderr.trim());
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u);
    }
    phase = "actual-native-runtime-chain";
    const nativeRuntime = await qualifyNativeChildren(built.tools, directory);
    phase = "actual-rust-refusal-smoke";
    const rust = invoke(path.join(built.tools, "bin/portcove-release-tools"), []);
    assert.equal(rust.error, undefined);
    assert.equal(rust.status, 1);
    assert.match(rust.stderr, /usage: portcove-release-tools/u);
    phase = "actual-core-cli-inert-inspection";
    const cli = path.join(built.tools, "bin/portcove");
    const cliVersion = invoke(cli, ["--version"]);
    assert.equal(cliVersion.error, undefined);
    assert.equal(cliVersion.status, 0);
    assert.match(cliVersion.stdout.trim(), /^portcove \d+\.\d+\.\d+/u);
    const bundle = path.join(directory, "empty-definition-bundle");
    const unopenedLibrary = path.join(directory, "unopened-library");
    await mkdir(path.join(bundle, "definitions"), { recursive: true, mode: 0o700 });
    const index = Buffer.from('{"index_schema":1,"definitions":[],"contents":[]}');
    await writeFile(path.join(bundle, "definitions/index.json"), index, {
      flag: "wx",
      mode: 0o600,
    });
    const inspect = () =>
      invoke(cli, [
        "--library",
        unopenedLibrary,
        "--json",
        "catalog",
        "inspect-definition-publication",
        bundle,
      ]);
    const inspected = inspect();
    assert.equal(inspected.error, undefined);
    assert.equal(inspected.status, 0, inspected.stderr);
    const inspectedReport = readCatalogCoreMachineEnvelope(
      inspected.stdout,
      inspected.stderr,
      new Map([["definitions/index.json", index]]),
    );
    assert.deepEqual(inspectedReport, {
      publication_schema: 1,
      authority: "none",
      index_sha256: createHash("sha256").update(index).digest("hex"),
      files: [
        {
          target: "definitions/index.json",
          bytes: index.length,
          sha256: createHash("sha256").update(index).digest("hex"),
        },
      ],
      definitions: [],
      scope: "inert-managed-definition-publication-inspection",
    });
    await assert.rejects(lstat(unopenedLibrary), { code: "ENOENT" });
    await record("core-cli-inspection.json", JSON.parse(inspected.stdout) as unknown);
    await writeFile(path.join(bundle, "extra.json"), "{}", { flag: "wx", mode: 0o600 });
    const extra = inspect();
    assert.equal(extra.error, undefined);
    assert.notEqual(extra.status, 0);
    await assert.rejects(lstat(unopenedLibrary), { code: "ENOENT" });
    phase = "actual-connected-disposable-release";
    const rustFile = built.manifest.files.find(
      (file) => file.path === "bin/portcove-release-tools",
    );
    const addonFile = built.manifest.files.find((file) => file.path === "bin/tauri-addon.node");
    assert.ok(rustFile && addonFile);
    const connected = spawnSync(node, ["--test", "scripts/release-connected-fixture.test.mts"], {
      cwd: source,
      env: {
        ...env,
        PATH: "/usr/bin:/bin",
        PORTCOVE_REQUIRE_CONNECTED_RELEASE_FIXTURE: "1",
        PORTCOVE_CONNECTED_RELEASE_TOOL: path.join(built.tools, rustFile.path),
        PORTCOVE_CONNECTED_RELEASE_TOOL_SHA256: rustFile.sha256,
        PORTCOVE_CONNECTED_RELEASE_ADDON: addon,
        PORTCOVE_CONNECTED_RELEASE_ADDON_SHA256: addonFile.sha256,
        PORTCOVE_CONNECTED_KEYLESS_ENTRY: path.join(
          built.tools,
          "scripts/release-native-keyless-assembly.bundle.mjs",
        ),
      },
      encoding: "utf8",
      timeout: 125000,
      maxBuffer: 128 * 1024,
    });
    await record("connected-release.json", {
      status: connected.status,
      error: connected.error?.message.slice(0, 1024) ?? null,
      stdout: boundedFixtureOutput(connected.stdout),
      stderr: boundedFixtureOutput(connected.stderr),
      scope: "disposable byte/crypto and prepared process chain only",
      authority: "none",
      native_acceptance: "not-established",
    });
    if (connected.error || connected.status !== 0) {
      process.stderr.write(connected.stderr);
      process.stderr.write(connected.stdout);
      throw new Error("connected disposable release fixture refused");
    }
    phase = "cold-build-budget";
    // The held production job retains its four-minute ceiling. Reserve thirty
    // seconds for checkout/dependency setup/upload; this measured build is not
    // a guarantee of later operation availability or full-job completion.
    assert.ok(
      buildMilliseconds <= 210000,
      "cold fixed tool build exceeds its preparation allowance",
    );
    phase = "complete";
    await record("result.json", {
      schema_version: 1,
      status: "pass",
      phase,
      node_runtime: nodeRuntime,
      built_directory: builtDirectory,
      build_work: buildWork,
      build_milliseconds: buildMilliseconds,
      build_allowance_milliseconds: 210000,
      build_profile: "controller-tools",
      tool_build_observation: {
        scope: "builder entry through complete inventory; cold workflow setup excluded",
        elapsed_milliseconds: built.elapsed_milliseconds,
        phases: built.timings,
      },
      tool_expanded_bytes: built.manifest.files.reduce((total, file) => total + file.bytes, 0),
      pnpm_runtime: pnpmRuntime,
      core_cli_bytes: built.manifest.files.find((file) => file.path === "bin/portcove")!.bytes,
      core_cli_smoke:
        "version-and-inert-empty-bundle-inspection-with-extra-file-refusal; no library or admission",
      source: expected,
      evidence_scope: "ordinary-hosted-fixture",
      rust_smoke: "usage-refusal-only",
      tauri_smoke: "version-and-supported-sign-build-flags-only",
      native_driver_smoke:
        "pinned-build/help-and-unsupported-version-refusal; no server or candidate",
      connected_release:
        "actual-disposable-payload-and-five-role-Tough; controlled-provider-site-renewal-journal-recovery; no hosted authorization or native execution",
      node_bundles: controllerToolEntries,
      native_runtime: nativeRuntime,
      native_child_bundles: controllerToolChildren,
      production_tool_acceptance: "not-established",
      authority: "none",
    });
  } catch (error: unknown) {
    await record("result.json", {
      schema_version: 1,
      status: "fail",
      phase,
      failure: boundedFixtureOutput(
        error instanceof Error ? error.message : "unknown fixture failure",
      ),
      build_milliseconds: buildMilliseconds,
      build_allowance_milliseconds: 210000,
      build_profile: "controller-tools",
      node_runtime: nodeRuntime,
      built_directory: builtDirectory,
      build_work: buildWork,
      evidence_scope: "ordinary-hosted-fixture",
      production_tool_acceptance: "not-established",
      authority: "none",
    });
    throw new Error(`controller tool build fixture refused; retain ${directory}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "controller tool build fixture refused");
    process.exitCode = 2;
  });
