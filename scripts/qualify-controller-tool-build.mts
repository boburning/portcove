/** Ordinary credential-free hosted build fixture. Never a production tool route. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildControllerTools } from "./release-controller-tool-build.mts";
import {
  controllerToolEntries,
  controllerCompilerSourceAsset,
  readControllerToolFile,
} from "./release-controller-tools.mts";
import { inspectReleaseCompilerSourceClosure } from "./release-compiler-source-closure.mts";
import { controllerNodeVersion } from "./controller-node-runtime.mts";

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
    const buildMilliseconds = Math.ceil(performance.now() - buildStarted);
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
        ].includes(name)
          ? 2
          : 1,
        name,
      );
      assert.ok(result.stderr.trim(), name);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u);
    }
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
    const inspectedJson: unknown = JSON.parse(inspected.stdout);
    assert.ok(
      typeof inspectedJson === "object" && inspectedJson !== null && "data" in inspectedJson,
    );
    assert.deepEqual(inspectedJson.data, {
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
    await record("core-cli-inspection.json", inspectedJson);
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
      },
      encoding: "utf8",
      timeout: 125000,
      maxBuffer: 128 * 1024,
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
      tool_expanded_bytes: built.manifest.files.reduce((total, file) => total + file.bytes, 0),
      core_cli_bytes: built.manifest.files.find((file) => file.path === "bin/portcove")!.bytes,
      core_cli_smoke:
        "version-and-inert-empty-bundle-inspection-with-extra-file-refusal; no library or admission",
      source: expected,
      evidence_scope: "ordinary-hosted-fixture",
      rust_smoke: "usage-refusal-only",
      tauri_smoke: "version-and-supported-sign-build-flags-only",
      connected_release:
        "actual-disposable-payload-and-five-role-Tough; controlled-provider-site-renewal-journal-recovery; no hosted authorization or native execution",
      node_bundles: controllerToolEntries,
      production_tool_acceptance: "not-established",
      authority: "none",
    });
  } catch {
    await record("result.json", {
      schema_version: 1,
      status: "fail",
      phase,
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
